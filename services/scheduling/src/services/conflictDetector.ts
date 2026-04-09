import { DateTime } from 'luxon';
import { pool } from '../db';
import { logger } from '../utils/logger';

export interface ConflictCheckParams {
  providerId: string;
  patientId: string;
  startTime: Date;
  endTime: Date;
  excludeAppointmentId?: string; // exclude an appointment (for updates)
}

export interface Conflict {
  id: string;
  startTime: Date;
  endTime: Date;
  conflictType: 'provider' | 'patient' | 'room';
  description: string;
}

// Minimum buffer between appointments (minutes)
// This is separate from the scheduling service's buffer because
// conflicts and availability are checked independently
// TODO: unify these - having two different buffer values is confusing
const CONFLICT_BUFFER_MINUTES = 0; // no buffer for conflict detection
// ^ changed from 5 to 0 after complaints that valid back-to-back
// appointments were being rejected. But now we have the opposite problem
// where providers have zero break time. Sigh.

export class ConflictDetector {
  /**
   * Check for scheduling conflicts
   *
   * Returns an array of conflicts. Empty array means no conflicts.
   *
   * Checks:
   * 1. Provider double-booking (same provider, overlapping time)
   * 2. Patient double-booking (same patient, overlapping time)
   * 3. Room conflicts (if room is assigned) - TODO: not implemented yet
   *
   * Edge cases that ARE handled:
   * - Appointment A ends at 10:00, Appointment B starts at 10:00 -> no conflict
   * - Cancelled/completed appointments don't create conflicts
   *
   * Edge cases that are NOT handled:
   * - Appointments spanning midnight (rare but possible for ER/surgery)
   * - Timezone boundaries (if provider TZ changes due to DST during the appointment)
   * - Travel time between locations for providers who work at multiple sites
   */
  async checkConflicts(params: ConflictCheckParams): Promise<Conflict[]> {
    const { providerId, patientId, startTime, endTime, excludeAppointmentId } = params;
    const conflicts: Conflict[] = [];

    // Apply buffer
    const bufferedStart = new Date(startTime.getTime() - CONFLICT_BUFFER_MINUTES * 60 * 1000);
    const bufferedEnd = new Date(endTime.getTime() + CONFLICT_BUFFER_MINUTES * 60 * 1000);

    // Check provider conflicts
    const providerConflicts = await this.checkProviderConflicts(
      providerId, bufferedStart, bufferedEnd, excludeAppointmentId
    );
    conflicts.push(...providerConflicts);

    // Check patient conflicts
    const patientConflicts = await this.checkPatientConflicts(
      patientId, bufferedStart, bufferedEnd, excludeAppointmentId
    );
    conflicts.push(...patientConflicts);

    // TODO: check room conflicts
    // This requires knowing which room the appointment will be in,
    // which isn't always known at booking time

    if (conflicts.length > 0) {
      logger.info('Scheduling conflicts detected', {
        providerId,
        patientId,
        requestedStart: startTime.toISOString(),
        requestedEnd: endTime.toISOString(),
        conflictCount: conflicts.length,
        conflictTypes: conflicts.map(c => c.conflictType),
      });
    }

    return conflicts;
  }

  /**
   * Check for provider double-booking
   */
  private async checkProviderConflicts(
    providerId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Conflict[]> {
    let query = `
      SELECT id, start_time, end_time, patient_id, type
      FROM appointments
      WHERE provider_id = $1
        AND status NOT IN ('cancelled', 'completed', 'no_show')
        AND start_time < $3
        AND end_time > $2
    `;
    const params: any[] = [providerId, start, end];

    if (excludeId) {
      query += ` AND id != $4`;
      params.push(excludeId);
    }

    const result = await pool.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      conflictType: 'provider' as const,
      description: `Provider has an existing ${row.type} appointment from ${formatTime(row.start_time)} to ${formatTime(row.end_time)}`,
    }));
  }

  /**
   * Check for patient double-booking
   */
  private async checkPatientConflicts(
    patientId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Conflict[]> {
    let query = `
      SELECT id, start_time, end_time, provider_id, type
      FROM appointments
      WHERE patient_id = $1
        AND status NOT IN ('cancelled', 'completed', 'no_show')
        AND start_time < $3
        AND end_time > $2
    `;
    const params: any[] = [patientId, start, end];

    if (excludeId) {
      query += ` AND id != $4`;
      params.push(excludeId);
    }

    const result = await pool.query(query, params);

    return result.rows.map(row => ({
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time,
      conflictType: 'patient' as const,
      description: `Patient has an existing ${row.type} appointment from ${formatTime(row.start_time)} to ${formatTime(row.end_time)}`,
    }));
  }

  /**
   * Check for conflicts across a batch of appointments
   * Used when creating recurring appointment series
   * TODO: this is O(n) database queries which is slow for long series
   * Should batch into a single query
   */
  async checkBatchConflicts(appointments: ConflictCheckParams[]): Promise<Map<number, Conflict[]>> {
    const results = new Map<number, Conflict[]>();

    for (let i = 0; i < appointments.length; i++) {
      const conflicts = await this.checkConflicts(appointments[i]);
      if (conflicts.length > 0) {
        results.set(i, conflicts);
      }
    }

    return results;
  }

  /**
   * Find the nearest non-conflicting time for a requested slot
   * Useful for suggesting alternative times when a conflict is found
   *
   * TODO: this is a naive implementation that just searches forward in
   * 15-minute increments. Should use the actual availability windows
   * to be smarter about suggestions.
   */
  async findNearestAvailable(
    providerId: string,
    patientId: string,
    preferredStart: Date,
    durationMinutes: number,
    searchWindow: number = 7, // days to search forward
  ): Promise<{ start: Date; end: Date } | null> {
    const maxSearch = new Date(preferredStart.getTime() + searchWindow * 24 * 60 * 60 * 1000);
    let candidate = new Date(preferredStart);

    // Search in 15-minute increments
    // This could be up to 672 iterations for a 7-day window (7 * 24 * 4)
    // which means 672 database queries. Not great, Bob.
    // TODO: optimize this significantly
    let iterations = 0;
    const MAX_ITERATIONS = 200; // safety limit

    while (candidate < maxSearch && iterations < MAX_ITERATIONS) {
      iterations++;
      const candidateEnd = new Date(candidate.getTime() + durationMinutes * 60 * 1000);

      const conflicts = await this.checkConflicts({
        providerId,
        patientId,
        startTime: candidate,
        endTime: candidateEnd,
      });

      if (conflicts.length === 0) {
        return { start: candidate, end: candidateEnd };
      }

      // Jump ahead 15 minutes
      candidate = new Date(candidate.getTime() + 15 * 60 * 1000);

      // Skip non-business hours (rough heuristic)
      // TODO: use actual provider availability instead of hardcoded hours
      const hour = candidate.getUTCHours(); // BUG: using UTC instead of provider TZ
      if (hour >= 18) { // after 6pm
        // Skip to 8am next day
        candidate = new Date(candidate);
        candidate.setUTCDate(candidate.getUTCDate() + 1);
        candidate.setUTCHours(8, 0, 0, 0);
      } else if (hour < 8) { // before 8am
        candidate.setUTCHours(8, 0, 0, 0);
      }
    }

    logger.warn('Could not find available slot within search window', {
      providerId,
      preferredStart: preferredStart.toISOString(),
      searchedDays: searchWindow,
      iterations,
    });

    return null;
  }
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
