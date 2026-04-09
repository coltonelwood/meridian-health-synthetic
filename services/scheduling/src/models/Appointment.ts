import { pool } from '../db';

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'checked_in'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type AppointmentType =
  | 'initial_consultation'
  | 'follow_up'
  | 'annual_physical'
  | 'urgent_care'
  | 'telemedicine'
  | 'procedure'
  | 'lab_work'
  | 'imaging'
  | 'vaccination'
  | 'therapy'
  | 'other';

export interface Appointment {
  id: string;
  providerId: string;
  patientId: string;
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
  type: AppointmentType;
  status: AppointmentStatus;
  notes?: string;
  reasonForVisit?: string;
  isTelemedicine: boolean;
  telemedicineLink?: string;
  roomNumber?: string;
  checkInTime?: Date;
  checkOutTime?: Date;
  cancellationReason?: string;
  cancelledBy?: string;
  // Billing info
  insuranceVerified: boolean;
  copayAmount?: number;
  copayCollected: boolean;
  // Recurrence (for series of appointments)
  recurringScheduleId?: string;
  seriesIndex?: number;
  // Metadata
  organizationId: string;
  locationId?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

// Valid status transitions
// TODO: this should be enforced at the database level too
const VALID_STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],  // terminal state
  cancelled: [],  // terminal state
  no_show: ['scheduled'], // can reschedule a no-show
};

export class AppointmentModel {
  async findById(id: string): Promise<Appointment | null> {
    const result = await pool.query(`SELECT * FROM appointments WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async findByProvider(providerId: string, startDate: Date, endDate: Date): Promise<Appointment[]> {
    const result = await pool.query(
      `SELECT * FROM appointments
       WHERE provider_id = $1
         AND start_time >= $2
         AND start_time <= $3
         AND status NOT IN ('cancelled')
       ORDER BY start_time`,
      [providerId, startDate, endDate]
    );
    return result.rows.map(this.mapRow);
  }

  async findByPatient(patientId: string, startDate?: Date, endDate?: Date): Promise<Appointment[]> {
    let query = `SELECT * FROM appointments WHERE patient_id = $1`;
    const params: any[] = [patientId];
    let idx = 2;

    if (startDate) {
      query += ` AND start_time >= $${idx++}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND start_time <= $${idx++}`;
      params.push(endDate);
    }

    query += ` ORDER BY start_time DESC`;
    const result = await pool.query(query, params);
    return result.rows.map(this.mapRow);
  }

  /**
   * Validate a status transition
   */
  isValidTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
    const allowed = VALID_STATUS_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  /**
   * Get upcoming appointments that need reminders
   * Used by a cron job to trigger reminder notifications
   */
  async getUpcomingForReminders(hoursAhead: number): Promise<Appointment[]> {
    const from = new Date();
    const to = new Date(from.getTime() + hoursAhead * 60 * 60 * 1000);

    const result = await pool.query(
      `SELECT a.* FROM appointments a
       LEFT JOIN appointment_reminders ar ON a.id = ar.appointment_id
       WHERE a.start_time BETWEEN $1 AND $2
         AND a.status IN ('scheduled', 'confirmed')
         AND ar.id IS NULL  -- no reminder sent yet
       ORDER BY a.start_time`,
      [from, to]
    );

    return result.rows.map(this.mapRow);
  }

  private mapRow(row: any): Appointment {
    return {
      id: row.id,
      providerId: row.provider_id,
      patientId: row.patient_id,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMinutes: row.duration_minutes,
      type: row.type,
      status: row.status,
      notes: row.notes,
      reasonForVisit: row.reason_for_visit,
      isTelemedicine: row.is_telemedicine || false,
      telemedicineLink: row.telemedicine_link,
      roomNumber: row.room_number,
      checkInTime: row.check_in_time,
      checkOutTime: row.check_out_time,
      cancellationReason: row.cancellation_reason,
      cancelledBy: row.cancelled_by,
      insuranceVerified: row.insurance_verified || false,
      copayAmount: row.copay_amount,
      copayCollected: row.copay_collected || false,
      recurringScheduleId: row.recurring_schedule_id,
      seriesIndex: row.series_index,
      organizationId: row.organization_id,
      locationId: row.location_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
  }
}
