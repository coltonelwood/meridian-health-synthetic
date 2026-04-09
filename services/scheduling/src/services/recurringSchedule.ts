import { RRule, RRuleSet } from 'rrule';
import { DateTime } from 'luxon';
import { ConflictDetector } from './conflictDetector';
import { pool } from '../db';
import { logger } from '../utils/logger';

/**
 * Handles recurring appointment scheduling using rrule (RFC 5545).
 *
 * Status: PARTIALLY IMPLEMENTED
 * - [x] Weekly recurring appointments
 * - [x] Bi-weekly appointments
 * - [ ] Monthly appointments (first/last/nth weekday)
 * - [ ] Custom recurrence patterns
 * - [ ] Editing a single instance vs entire series
 * - [ ] Deleting a single instance vs entire series
 * - [ ] Conflict handling for series (skip, reschedule, or fail?)
 *
 * Known issues:
 * - If any appointment in the series conflicts, the ENTIRE series creation fails
 *   (should allow partial creation with conflict skipping)
 * - No way to modify the recurrence pattern after creation
 * - Doesn't handle DST transitions properly (SCHED-278 again)
 */

export interface RecurringScheduleConfig {
  providerId: string;
  patientId: string;
  type: string;
  durationMinutes: number;
  startTime: string; // HH:mm
  frequency: 'weekly' | 'biweekly' | 'monthly';
  dayOfWeek?: number; // 0-6 for weekly/biweekly
  dayOfMonth?: number; // 1-31 for monthly
  startDate: Date;
  endDate?: Date; // if not set, defaults to 6 months
  maxOccurrences?: number;
  notes?: string;
  timezone: string;
}

export interface RecurringSchedule {
  id: string;
  config: RecurringScheduleConfig;
  appointments: string[]; // appointment IDs
  createdAt: Date;
}

const conflictDetector = new ConflictDetector();

export class RecurringScheduleService {
  /**
   * Create a recurring appointment series
   */
  async createRecurringSeries(config: RecurringScheduleConfig): Promise<{
    success: boolean;
    scheduleId?: string;
    appointmentsCreated?: number;
    conflicts?: Array<{ date: string; reason: string }>;
    error?: string;
  }> {
    try {
      // Generate occurrence dates using rrule
      const dates = this.generateOccurrences(config);

      if (dates.length === 0) {
        return { success: false, error: 'No valid occurrences generated' };
      }

      // Check for conflicts on all dates
      // TODO: this is very slow for long series - should batch
      const conflicts: Array<{ date: string; reason: string }> = [];

      for (const date of dates) {
        const [hours, minutes] = config.startTime.split(':').map(Number);
        const startDt = DateTime.fromJSDate(date, { zone: config.timezone })
          .set({ hour: hours, minute: minutes });
        const endDt = startDt.plus({ minutes: config.durationMinutes });

        const dateConflicts = await conflictDetector.checkConflicts({
          providerId: config.providerId,
          patientId: config.patientId,
          startTime: startDt.toJSDate(),
          endTime: endDt.toJSDate(),
        });

        if (dateConflicts.length > 0) {
          conflicts.push({
            date: startDt.toISO()!,
            reason: dateConflicts[0].description,
          });
        }
      }

      // Current behavior: fail if ANY conflicts exist
      // TODO: allow partial creation with conflict skipping
      if (conflicts.length > 0) {
        return {
          success: false,
          error: `${conflicts.length} scheduling conflicts found`,
          conflicts,
        };
      }

      // Create the recurring schedule record
      const scheduleResult = await pool.query(
        `INSERT INTO recurring_schedules (
          id, provider_id, patient_id, config, created_at
        ) VALUES (gen_random_uuid(), $1, $2, $3, NOW())
        RETURNING id`,
        [config.providerId, config.patientId, JSON.stringify(config)]
      );

      const scheduleId = scheduleResult.rows[0].id;

      // Create individual appointments
      // TODO: should be in a transaction so we don't get partial series
      const appointmentIds: string[] = [];

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const [hours, minutes] = config.startTime.split(':').map(Number);
        const startDt = DateTime.fromJSDate(date, { zone: config.timezone })
          .set({ hour: hours, minute: minutes });
        const endDt = startDt.plus({ minutes: config.durationMinutes });

        const result = await pool.query(
          `INSERT INTO appointments (
            id, provider_id, patient_id, start_time, end_time,
            duration_minutes, type, status, notes,
            recurring_schedule_id, series_index,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'scheduled', $7, $8, $9, NOW(), NOW()
          ) RETURNING id`,
          [
            config.providerId, config.patientId,
            startDt.toJSDate(), endDt.toJSDate(),
            config.durationMinutes, config.type,
            config.notes, scheduleId, i,
          ]
        );

        appointmentIds.push(result.rows[0].id);
      }

      logger.info('Recurring series created', {
        scheduleId,
        providerId: config.providerId,
        patientId: config.patientId,
        frequency: config.frequency,
        appointmentsCreated: appointmentIds.length,
      });

      return {
        success: true,
        scheduleId,
        appointmentsCreated: appointmentIds.length,
      };

    } catch (error: any) {
      logger.error('Failed to create recurring series', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate occurrence dates based on recurrence config
   */
  private generateOccurrences(config: RecurringScheduleConfig): Date[] {
    const startDate = config.startDate;
    const endDate = config.endDate || new Date(startDate.getTime() + 180 * 24 * 60 * 60 * 1000); // 6 months
    const maxOccurrences = config.maxOccurrences || 52; // default max 1 year of weekly

    let rruleFreq: number;
    let interval = 1;

    switch (config.frequency) {
      case 'weekly':
        rruleFreq = RRule.WEEKLY;
        break;
      case 'biweekly':
        rruleFreq = RRule.WEEKLY;
        interval = 2;
        break;
      case 'monthly':
        rruleFreq = RRule.MONTHLY;
        // TODO: implement nth weekday of month
        // Right now monthly just uses the same day of month
        // which doesn't work for "every 2nd Tuesday" type schedules
        break;
      default:
        throw new Error(`Unsupported frequency: ${config.frequency}`);
    }

    const rule = new RRule({
      freq: rruleFreq,
      interval,
      dtstart: startDate,
      until: endDate,
      count: maxOccurrences,
      // TODO: handle byweekday for monthly recurring
      // byweekday: config.dayOfWeek !== undefined ? [config.dayOfWeek] : undefined,
    });

    return rule.all();
  }

  /**
   * Cancel a single occurrence in a recurring series
   * TODO: not implemented - currently you have to cancel the appointment
   * individually which doesn't update the recurring schedule record
   */
  async cancelOccurrence(scheduleId: string, appointmentId: string): Promise<boolean> {
    throw new Error('Not implemented - cancel the appointment directly instead');
  }

  /**
   * Cancel an entire recurring series
   */
  async cancelSeries(scheduleId: string, reason?: string): Promise<number> {
    const result = await pool.query(
      `UPDATE appointments SET
        status = 'cancelled',
        cancellation_reason = $2,
        updated_at = NOW()
       WHERE recurring_schedule_id = $1
         AND status NOT IN ('completed', 'cancelled')
       RETURNING id`,
      [scheduleId, reason || 'Series cancelled']
    );

    const count = result.rowCount || 0;
    logger.info('Recurring series cancelled', { scheduleId, appointmentsCancelled: count });
    return count;
  }
}
