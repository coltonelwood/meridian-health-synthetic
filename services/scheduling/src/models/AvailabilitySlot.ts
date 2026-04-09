import { pool } from '../db';

export interface AvailabilitySlot {
  id: string;
  providerId: string;
  dayOfWeek: number; // 0=Sunday, 6=Saturday
  startTime: string; // HH:mm in provider's local timezone
  endTime: string;   // HH:mm in provider's local timezone
  slotTypes: string[]; // appointment types accepted in this slot
  isActive: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

export interface AvailabilityOverride {
  id: string;
  providerId: string;
  overrideDate: string; // YYYY-MM-DD
  overrideType: 'unavailable' | 'modified_hours';
  startTime?: string; // HH:mm (for modified_hours)
  endTime?: string;
  reason?: string;
  createdAt: Date;
}

// Represents a computed available time window (after accounting for
// existing appointments and overrides)
export interface AvailableWindow {
  start: Date;
  end: Date;
  duration: number; // in minutes
  providerTimezone: string;
}

export class AvailabilityModel {
  /**
   * Get a provider's regular weekly schedule
   */
  async getWeeklySchedule(providerId: string): Promise<AvailabilitySlot[]> {
    const result = await pool.query(
      `SELECT * FROM availability_slots
       WHERE provider_id = $1 AND is_active = true
       ORDER BY day_of_week, start_time`,
      [providerId]
    );

    return result.rows.map(this.mapSlotRow);
  }

  /**
   * Get availability overrides for a date range
   */
  async getOverrides(providerId: string, startDate: Date, endDate: Date): Promise<AvailabilityOverride[]> {
    const result = await pool.query(
      `SELECT * FROM availability_overrides
       WHERE provider_id = $1
         AND override_date >= $2
         AND override_date <= $3
       ORDER BY override_date`,
      [providerId, startDate, endDate]
    );

    return result.rows.map(this.mapOverrideRow);
  }

  /**
   * Check if a provider has any availability on a specific day
   */
  async hasAvailabilityOnDay(providerId: string, dayOfWeek: number): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM availability_slots
       WHERE provider_id = $1 AND day_of_week = $2 AND is_active = true
       LIMIT 1`,
      [providerId, dayOfWeek]
    );
    return result.rows.length > 0;
  }

  /**
   * Get the provider's timezone
   * TODO: cache this - it's called on every slot lookup
   */
  async getProviderTimezone(providerId: string): Promise<string> {
    const result = await pool.query(
      `SELECT timezone FROM providers WHERE id = $1`,
      [providerId]
    );

    if (result.rows.length === 0) {
      // Default to Eastern Time
      // This is wrong but at least consistent with the rest of the codebase
      return 'America/New_York';
    }

    return result.rows[0].timezone || 'America/New_York';
  }

  private mapSlotRow(row: any): AvailabilitySlot {
    return {
      id: row.id,
      providerId: row.provider_id,
      dayOfWeek: row.day_of_week,
      startTime: row.start_time,
      endTime: row.end_time,
      slotTypes: typeof row.slot_types === 'string'
        ? JSON.parse(row.slot_types)
        : (row.slot_types || ['all']),
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapOverrideRow(row: any): AvailabilityOverride {
    return {
      id: row.id,
      providerId: row.provider_id,
      overrideDate: row.override_date,
      overrideType: row.override_type,
      startTime: row.start_time,
      endTime: row.end_time,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }
}
