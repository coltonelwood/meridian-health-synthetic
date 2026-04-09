import { Router, Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { DateTime } from 'luxon';
import { SchedulingService } from '../services/schedulingService';
import { pool } from '../db';
import { logger } from '../utils/logger';

const router = Router();
const schedulingService = new SchedulingService();

// Default timezone - used when provider hasn't set their timezone
// TODO: this is a bad default for providers in Hawaii or other non-continental US zones
const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * GET /providers/:providerId/slots
 * Get available time slots for a provider within a date range
 *
 * This is the most complex endpoint in the scheduling service.
 * It needs to:
 * 1. Get the provider's defined availability schedule
 * 2. Get any availability overrides (holidays, PTO, etc.)
 * 3. Get existing appointments
 * 4. Handle recurring schedules
 * 5. Handle timezone conversions (provider TZ vs patient TZ vs UTC)
 * 6. Calculate available slots
 *
 * Known bugs:
 * - Slots that cross midnight in the provider's timezone can appear on the wrong day
 * - DST transitions cause duplicate or missing slots (SCHED-278)
 * - The slot duration doesn't account for buffer time between appointments
 */
router.get('/providers/:providerId/slots', [
  param('providerId').isUUID(),
  query('startDate').isISO8601(),
  query('endDate').isISO8601(),
  query('duration').optional().isInt({ min: 5, max: 480 }),
  query('appointmentType').optional().isString(),
  query('timezone').optional().isString(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: errors.array() } });
    }

    const { providerId } = req.params;
    const {
      startDate,
      endDate,
      duration = '30', // default 30 min slots
      appointmentType,
      timezone,
    } = req.query as Record<string, string>;

    // Validate date range isn't too large
    const start = DateTime.fromISO(startDate);
    const end = DateTime.fromISO(endDate);

    if (!start.isValid || !end.isValid) {
      return res.status(400).json({
        error: { code: 'INVALID_DATE', message: 'Invalid date format' },
      });
    }

    const daysDiff = end.diff(start, 'days').days;
    if (daysDiff > 90) {
      return res.status(400).json({
        error: { code: 'RANGE_TOO_LARGE', message: 'Date range cannot exceed 90 days' },
      });
    }
    if (daysDiff < 0) {
      return res.status(400).json({
        error: { code: 'INVALID_RANGE', message: 'End date must be after start date' },
      });
    }

    // Get provider's timezone
    const providerResult = await pool.query(
      `SELECT timezone, default_slot_duration FROM providers WHERE id = $1`,
      [providerId]
    );

    if (providerResult.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Provider not found' },
      });
    }

    const providerTimezone = providerResult.rows[0].timezone || DEFAULT_TIMEZONE;
    const requestedTimezone = timezone || providerTimezone;
    const slotDuration = parseInt(duration) || providerResult.rows[0].default_slot_duration || 30;

    // BUG: When requestedTimezone !== providerTimezone, we need to convert
    // the availability windows from provider TZ to requested TZ.
    // But we're currently doing the conversion AFTER slicing into slots,
    // which can cause slots near midnight to shift to the wrong day.
    // This is the bug in SCHED-278 and nobody has figured out how to fix
    // it cleanly yet.

    const slots = await schedulingService.getAvailableSlots({
      providerId,
      startDate: start.toJSDate(),
      endDate: end.toJSDate(),
      slotDuration,
      appointmentType,
      providerTimezone,
      requestedTimezone,
    });

    return res.json({
      providerId,
      timezone: requestedTimezone,
      slotDuration,
      dateRange: { start: startDate, end: endDate },
      slots,
      totalAvailable: slots.length,
    });
  } catch (error: any) {
    logger.error('Error getting availability slots', { error: error.message });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get availability' } });
  }
});

/**
 * GET /providers/:providerId/schedule
 * Get a provider's configured availability schedule
 */
router.get('/providers/:providerId/schedule', [
  param('providerId').isUUID(),
], async (req: Request, res: Response) => {
  try {
    const { providerId } = req.params;

    const result = await pool.query(
      `SELECT * FROM availability_slots
       WHERE provider_id = $1 AND is_active = true
       ORDER BY day_of_week, start_time`,
      [providerId]
    );

    // Also get overrides (PTO, holidays, special hours)
    const overrides = await pool.query(
      `SELECT * FROM availability_overrides
       WHERE provider_id = $1 AND override_date >= CURRENT_DATE
       ORDER BY override_date`,
      [providerId]
    );

    return res.json({
      providerId,
      regularSchedule: result.rows,
      overrides: overrides.rows,
    });
  } catch (error: any) {
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get schedule' } });
  }
});

/**
 * PUT /providers/:providerId/schedule
 * Set a provider's weekly availability schedule
 */
router.put('/providers/:providerId/schedule', [
  param('providerId').isUUID(),
  body('schedule').isArray(),
  body('schedule.*.dayOfWeek').isInt({ min: 0, max: 6 }), // 0=Sunday
  body('schedule.*.startTime').matches(/^\d{2}:\d{2}$/), // HH:mm
  body('schedule.*.endTime').matches(/^\d{2}:\d{2}$/),
  body('schedule.*.slotTypes').optional().isArray(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: errors.array() } });
    }

    const { providerId } = req.params;
    const { schedule } = req.body;

    // Validate times make sense
    for (const slot of schedule) {
      if (slot.startTime >= slot.endTime) {
        // TODO: handle overnight shifts (e.g., 22:00 - 06:00)
        // Right now we reject them which means ER doctors can't set
        // their availability properly
        return res.status(400).json({
          error: {
            code: 'INVALID_TIMES',
            message: `Start time must be before end time for ${getDayName(slot.dayOfWeek)}`,
          },
        });
      }
    }

    // Replace all existing schedule entries
    // TODO: this should be a transaction
    await pool.query(
      `UPDATE availability_slots SET is_active = false WHERE provider_id = $1`,
      [providerId]
    );

    for (const slot of schedule) {
      await pool.query(
        `INSERT INTO availability_slots (
          id, provider_id, day_of_week, start_time, end_time,
          slot_types, is_active, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, true, NOW()
        )`,
        [
          providerId, slot.dayOfWeek, slot.startTime, slot.endTime,
          JSON.stringify(slot.slotTypes || ['all']),
        ]
      );
    }

    logger.info('Provider schedule updated', { providerId, slots: schedule.length });

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Error updating schedule', { error: error.message });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update schedule' } });
  }
});

/**
 * POST /providers/:providerId/overrides
 * Add an availability override (PTO, special hours, etc.)
 */
router.post('/providers/:providerId/overrides', [
  param('providerId').isUUID(),
  body('date').isISO8601(),
  body('type').isIn(['unavailable', 'modified_hours']),
  body('startTime').optional().matches(/^\d{2}:\d{2}$/),
  body('endTime').optional().matches(/^\d{2}:\d{2}$/),
  body('reason').optional().isString().isLength({ max: 255 }),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: errors.array() } });
    }

    const { providerId } = req.params;
    const { date, type, startTime, endTime, reason } = req.body;

    // Check if there's already an override for this date
    const existing = await pool.query(
      `SELECT id FROM availability_overrides WHERE provider_id = $1 AND override_date = $2`,
      [providerId, date]
    );

    if (existing.rows.length > 0) {
      // Update existing override
      await pool.query(
        `UPDATE availability_overrides SET
          override_type = $1, start_time = $2, end_time = $3, reason = $4, updated_at = NOW()
         WHERE provider_id = $5 AND override_date = $6`,
        [type, startTime, endTime, reason, providerId, date]
      );
    } else {
      await pool.query(
        `INSERT INTO availability_overrides (
          id, provider_id, override_date, override_type,
          start_time, end_time, reason, created_at
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())`,
        [providerId, date, type, startTime, endTime, reason]
      );
    }

    // If marking unavailable, check for existing appointments on that date
    // and warn (but don't auto-cancel)
    if (type === 'unavailable') {
      const affectedAppts = await pool.query(
        `SELECT id, patient_id, start_time FROM appointments
         WHERE provider_id = $1
           AND DATE(start_time) = $2
           AND status NOT IN ('cancelled', 'completed')`,
        [providerId, date]
      );

      if (affectedAppts.rows.length > 0) {
        logger.warn('Provider marked as unavailable with existing appointments', {
          providerId,
          date,
          affectedCount: affectedAppts.rows.length,
        });

        return res.json({
          success: true,
          warning: `There are ${affectedAppts.rows.length} existing appointments on this date that may need to be rescheduled.`,
          affectedAppointments: affectedAppts.rows.map(a => ({
            id: a.id,
            startTime: a.start_time,
          })),
        });
      }
    }

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Error creating availability override', { error: error.message });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create override' } });
  }
});

function getDayName(dayOfWeek: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek] || 'Unknown';
}

export default router;
