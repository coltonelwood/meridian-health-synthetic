import { Router, Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { SchedulingService } from '../services/schedulingService';
import { ConflictDetector } from '../services/conflictDetector';
import { pool } from '../db';
import { logger } from '../utils/logger';

const router = Router();
const schedulingService = new SchedulingService();
const conflictDetector = new ConflictDetector();

// TODO: add auth middleware - right now this is wide open
// We removed it temporarily during the auth service refactor and
// forgot to add it back. Tracked in SCHED-445.
// For now the API gateway handles auth, but defense in depth says
// we should validate JWT here too.

/**
 * GET /
 * List appointments with filters
 */
router.get('/', [
  query('providerId').optional().isUUID(),
  query('patientId').optional().isUUID(),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('status').optional().isIn(['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']),
  query('limit').optional().isInt({ min: 1, max: 200 }),
  query('offset').optional().isInt({ min: 0 }),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: errors.array() } });
    }

    const {
      providerId, patientId, startDate, endDate, status,
      limit = '50', offset = '0'
    } = req.query as Record<string, string>;

    let queryStr = `SELECT a.*, p.first_name as patient_first_name, p.last_name as patient_last_name
                    FROM appointments a
                    LEFT JOIN patients p ON a.patient_id = p.id
                    WHERE 1=1`;
    const params: any[] = [];
    let paramIdx = 1;

    if (providerId) {
      queryStr += ` AND a.provider_id = $${paramIdx++}`;
      params.push(providerId);
    }
    if (patientId) {
      queryStr += ` AND a.patient_id = $${paramIdx++}`;
      params.push(patientId);
    }
    if (startDate) {
      queryStr += ` AND a.start_time >= $${paramIdx++}`;
      params.push(startDate);
    }
    if (endDate) {
      queryStr += ` AND a.start_time <= $${paramIdx++}`;
      params.push(endDate);
    }
    if (status) {
      queryStr += ` AND a.status = $${paramIdx++}`;
      params.push(status);
    }

    queryStr += ` ORDER BY a.start_time ASC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(queryStr, params);

    // TODO: this count query is slow on large tables
    // Should add a materialized view or use cursor-based pagination
    let countQuery = `SELECT COUNT(*) FROM appointments WHERE 1=1`;
    const countParams: any[] = [];
    let countIdx = 1;
    if (providerId) { countQuery += ` AND provider_id = $${countIdx++}`; countParams.push(providerId); }
    if (patientId) { countQuery += ` AND patient_id = $${countIdx++}`; countParams.push(patientId); }
    if (startDate) { countQuery += ` AND start_time >= $${countIdx++}`; countParams.push(startDate); }
    if (endDate) { countQuery += ` AND start_time <= $${countIdx++}`; countParams.push(endDate); }
    if (status) { countQuery += ` AND status = $${countIdx++}`; countParams.push(status); }
    const countResult = await pool.query(countQuery, countParams);

    return res.json({
      appointments: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error: any) {
    logger.error('Error listing appointments', { error: error.message });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list appointments' } });
  }
});

/**
 * GET /:id
 * Get a single appointment
 */
router.get('/:id', [param('id').isUUID()], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT a.*,
              pr.first_name as provider_first_name, pr.last_name as provider_last_name, pr.specialty,
              p.first_name as patient_first_name, p.last_name as patient_last_name
       FROM appointments a
       LEFT JOIN providers pr ON a.provider_id = pr.id
       LEFT JOIN patients p ON a.patient_id = p.id
       WHERE a.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Appointment not found' } });
    }

    return res.json({ appointment: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get appointment' } });
  }
});

/**
 * POST /
 * Create a new appointment
 *
 * TODO: RACE CONDITION - there's a window between checking for conflicts
 * and inserting the appointment where another request could book the same
 * slot. We need to use a database-level advisory lock or serializable
 * transaction isolation to prevent double-booking.
 * This has caused real double-bookings in production (SCHED-312, SCHED-389).
 * Current mitigation: API gateway rate limits to 1 req/sec per patient.
 */
router.post('/', [
  body('providerId').isUUID(),
  body('patientId').isUUID(),
  body('startTime').isISO8601(),
  body('duration').isInt({ min: 5, max: 480 }), // 5 min to 8 hours
  body('type').isIn([
    'initial_consultation', 'follow_up', 'annual_physical',
    'urgent_care', 'telemedicine', 'procedure', 'lab_work',
    'imaging', 'vaccination', 'therapy', 'other',
  ]),
  body('notes').optional().isString().isLength({ max: 2000 }),
  body('reasonForVisit').optional().isString().isLength({ max: 500 }),
  body('isTelemedicine').optional().isBoolean(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: errors.array() } });
    }

    const { providerId, patientId, startTime, duration, type, notes, reasonForVisit, isTelemedicine } = req.body;

    // Calculate end time
    const startDate = new Date(startTime);
    const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

    // Check for conflicts (THIS IS WHERE THE RACE CONDITION IS)
    const conflicts = await conflictDetector.checkConflicts({
      providerId,
      patientId,
      startTime: startDate,
      endTime: endDate,
    });

    if (conflicts.length > 0) {
      return res.status(409).json({
        error: {
          code: 'SCHEDULING_CONFLICT',
          message: 'The requested time slot conflicts with an existing appointment',
          conflicts: conflicts.map(c => ({
            id: c.id,
            startTime: c.startTime,
            endTime: c.endTime,
            type: c.conflictType,
          })),
        },
      });
    }

    // Check provider availability
    const isAvailable = await schedulingService.isProviderAvailable(providerId, startDate, endDate);
    if (!isAvailable) {
      return res.status(409).json({
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'The provider is not available during the requested time',
        },
      });
    }

    // Create the appointment
    // TODO: wrap this in a transaction with the conflict check (see race condition note above)
    const result = await pool.query(
      `INSERT INTO appointments (
        id, provider_id, patient_id, start_time, end_time, duration_minutes,
        type, status, notes, reason_for_visit, is_telemedicine,
        created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'scheduled', $7, $8, $9, NOW(), NOW()
      ) RETURNING *`,
      [providerId, patientId, startDate, endDate, duration, type, notes, reasonForVisit, isTelemedicine || false]
    );

    const appointment = result.rows[0];

    // Send confirmation notification
    // TODO: use message queue instead of direct HTTP call
    try {
      const fetch = (await import('node-fetch')).default;
      const notifUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notifications:3003';
      await fetch(`${notifUrl}/api/v1/notifications/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Key': process.env.INTERNAL_SERVICE_KEY || 'dev-key',
        },
        body: JSON.stringify({
          type: 'appointment_confirmation',
          channel: 'email',
          recipientId: patientId,
          templateId: 'appointment-reminder',
          data: {
            appointmentId: appointment.id,
            appointmentType: type.replace(/_/g, ' '),
            appointmentDate: startDate.toISOString(),
            appointmentTime: startDate.toISOString(),
            duration,
            isTelemedicine: isTelemedicine || false,
          },
        }),
      });
    } catch (notifError: any) {
      // Don't fail the appointment creation if notification fails
      logger.error('Failed to send appointment confirmation', { error: notifError.message });
    }

    logger.info('Appointment created', {
      appointmentId: appointment.id,
      providerId,
      patientId,
      startTime: startDate.toISOString(),
      type,
    });

    return res.status(201).json({ appointment });
  } catch (error: any) {
    logger.error('Error creating appointment', { error: error.message });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create appointment' } });
  }
});

/**
 * PATCH /:id
 * Update an appointment (reschedule, update notes, etc.)
 */
router.patch('/:id', [
  param('id').isUUID(),
  body('startTime').optional().isISO8601(),
  body('duration').optional().isInt({ min: 5, max: 480 }),
  body('status').optional().isIn(['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show']),
  body('notes').optional().isString().isLength({ max: 2000 }),
  body('cancellationReason').optional().isString().isLength({ max: 500 }),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: errors.array() } });
    }

    const { id } = req.params;
    const updates = req.body;

    // Check appointment exists
    const existing = await pool.query(`SELECT * FROM appointments WHERE id = $1`, [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Appointment not found' } });
    }

    const appointment = existing.rows[0];

    // Can't modify completed or cancelled appointments
    if (['completed', 'cancelled'].includes(appointment.status) && updates.status !== 'cancelled') {
      return res.status(400).json({
        error: { code: 'INVALID_STATUS', message: `Cannot modify ${appointment.status} appointment` },
      });
    }

    // If rescheduling, check for conflicts
    if (updates.startTime) {
      const newStart = new Date(updates.startTime);
      const duration = updates.duration || appointment.duration_minutes;
      const newEnd = new Date(newStart.getTime() + duration * 60 * 1000);

      const conflicts = await conflictDetector.checkConflicts({
        providerId: appointment.provider_id,
        patientId: appointment.patient_id,
        startTime: newStart,
        endTime: newEnd,
        excludeAppointmentId: id, // don't conflict with itself
      });

      if (conflicts.length > 0) {
        return res.status(409).json({
          error: {
            code: 'SCHEDULING_CONFLICT',
            message: 'The new time slot conflicts with an existing appointment',
            conflicts,
          },
        });
      }
    }

    // Build update query dynamically
    // TODO: this is a SQL injection vector if we're not careful
    // The field names come from the request body keys
    // We should whitelist allowed fields explicitly
    const allowedFields: Record<string, string> = {
      startTime: 'start_time',
      duration: 'duration_minutes',
      status: 'status',
      notes: 'notes',
      cancellationReason: 'cancellation_reason',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(updates)) {
      const dbField = allowedFields[key];
      if (dbField && value !== undefined) {
        setClauses.push(`${dbField} = $${paramIdx++}`);
        params.push(value);
      }
    }

    // If changing start time, also update end time
    if (updates.startTime) {
      const dur = updates.duration || appointment.duration_minutes;
      const newEnd = new Date(new Date(updates.startTime).getTime() + dur * 60 * 1000);
      setClauses.push(`end_time = $${paramIdx++}`);
      params.push(newEnd);
    }

    params.push(id);
    const updateQuery = `UPDATE appointments SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;

    const result = await pool.query(updateQuery, params);

    // If cancelled, send cancellation notification
    if (updates.status === 'cancelled') {
      try {
        const fetch = (await import('node-fetch')).default;
        const notifUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notifications:3003';
        await fetch(`${notifUrl}/api/v1/notifications/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Key': process.env.INTERNAL_SERVICE_KEY || 'dev-key',
          },
          body: JSON.stringify({
            type: 'appointment_cancellation',
            channel: 'all',
            recipientId: appointment.patient_id,
            data: {
              appointmentId: id,
              appointmentType: appointment.type,
              cancellationReason: updates.cancellationReason,
            },
          }),
        });
      } catch {
        logger.error('Failed to send cancellation notification');
      }
    }

    logger.info('Appointment updated', {
      appointmentId: id,
      changes: Object.keys(updates),
    });

    return res.json({ appointment: result.rows[0] });
  } catch (error: any) {
    logger.error('Error updating appointment', { error: error.message });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update appointment' } });
  }
});

/**
 * DELETE /:id
 * Cancel an appointment (soft delete - sets status to cancelled)
 */
router.delete('/:id', [
  param('id').isUUID(),
], async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('completed', 'cancelled')
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Appointment not found or already cancelled' },
      });
    }

    return res.json({ success: true, appointment: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to cancel appointment' } });
  }
});

export default router;
