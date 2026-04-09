import { DateTime, Interval } from 'luxon';
import { AvailabilityModel, AvailabilitySlot, AvailabilityOverride } from '../models/AvailabilitySlot';
import { AppointmentModel } from '../models/Appointment';
import { pool } from '../db';
import { logger } from '../utils/logger';

const availabilityModel = new AvailabilityModel();
const appointmentModel = new AppointmentModel();

// Buffer time between appointments (minutes)
// TODO: make this configurable per provider
// Dr. Martinez wants 15 min buffers, most others want 5
const BUFFER_BETWEEN_APPOINTMENTS = 5;

export interface SlotSearchParams {
  providerId: string;
  startDate: Date;
  endDate: Date;
  slotDuration: number;
  appointmentType?: string;
  providerTimezone: string;
  requestedTimezone: string;
}

export interface TimeSlot {
  start: string; // ISO 8601
  end: string;
  available: boolean;
  // Why is this slot unavailable? (for debugging mostly)
  reason?: string;
}

export class SchedulingService {
  /**
   * Get available time slots for a provider within a date range
   *
   * This algorithm is... complex. Here's the general approach:
   * 1. For each day in the range, get the provider's availability windows
   * 2. Subtract any overrides (PTO, holidays)
   * 3. Subtract any existing appointments
   * 4. Slice remaining windows into slots of the requested duration
   * 5. Convert to the requested timezone
   *
   * Known issues:
   * - Performance degrades with large date ranges (we should paginate)
   * - Doesn't account for BUFFER_BETWEEN_APPOINTMENTS consistently
   * - Timezone conversion happens too late (see SCHED-278)
   * - Doesn't consider provider's break/lunch times (those should be overrides)
   */
  async getAvailableSlots(params: SlotSearchParams): Promise<TimeSlot[]> {
    const {
      providerId, startDate, endDate, slotDuration,
      appointmentType, providerTimezone, requestedTimezone,
    } = params;

    // Get provider's weekly schedule
    const weeklySchedule = await availabilityModel.getWeeklySchedule(providerId);
    if (weeklySchedule.length === 0) {
      return []; // provider hasn't set up availability
    }

    // Get overrides for the date range
    const overrides = await availabilityModel.getOverrides(providerId, startDate, endDate);

    // Get existing appointments for the date range
    const existingAppointments = await appointmentModel.findByProvider(providerId, startDate, endDate);

    const allSlots: TimeSlot[] = [];

    // Iterate through each day in the range
    let current = DateTime.fromJSDate(startDate, { zone: providerTimezone }).startOf('day');
    const endDt = DateTime.fromJSDate(endDate, { zone: providerTimezone }).endOf('day');

    // Safety check: don't iterate more than 90 days
    let dayCount = 0;
    const MAX_DAYS = 90;

    while (current <= endDt && dayCount < MAX_DAYS) {
      dayCount++;
      const dayOfWeek = current.weekday % 7; // luxon uses 1=Monday, convert to 0=Sunday

      // Check for overrides on this day
      const dateStr = current.toFormat('yyyy-MM-dd');
      const override = overrides.find(o => o.overrideDate === dateStr);

      if (override?.overrideType === 'unavailable') {
        // Skip this day entirely
        current = current.plus({ days: 1 });
        continue;
      }

      // Get availability windows for this day of week
      let daySlots: AvailabilitySlot[];
      if (override?.overrideType === 'modified_hours') {
        // Use override hours instead of regular schedule
        daySlots = [{
          id: override.id,
          providerId,
          dayOfWeek,
          startTime: override.startTime || '09:00',
          endTime: override.endTime || '17:00',
          slotTypes: ['all'],
          isActive: true,
          createdAt: new Date(),
        }];
      } else {
        daySlots = weeklySchedule.filter(s => s.dayOfWeek === dayOfWeek);
      }

      // Filter by appointment type if specified
      if (appointmentType) {
        daySlots = daySlots.filter(s =>
          s.slotTypes.includes('all') || s.slotTypes.includes(appointmentType)
        );
      }

      // For each availability window, generate slots
      for (const slot of daySlots) {
        const [startHour, startMin] = slot.startTime.split(':').map(Number);
        const [endHour, endMin] = slot.endTime.split(':').map(Number);

        let windowStart = current.set({ hour: startHour, minute: startMin, second: 0 });
        const windowEnd = current.set({ hour: endHour, minute: endMin, second: 0 });

        // Don't return slots in the past
        const now = DateTime.now().setZone(providerTimezone);
        if (windowStart < now) {
          // Advance to the next available slot boundary
          const minutesSinceStart = now.diff(windowStart, 'minutes').minutes;
          const slotsToSkip = Math.ceil(minutesSinceStart / slotDuration);
          windowStart = windowStart.plus({ minutes: slotsToSkip * slotDuration });
        }

        // Generate slots within this window
        while (windowStart.plus({ minutes: slotDuration }) <= windowEnd) {
          const slotStart = windowStart;
          const slotEnd = windowStart.plus({ minutes: slotDuration });

          // Check if this slot overlaps with any existing appointment
          const isOccupied = existingAppointments.some(appt => {
            const apptStart = DateTime.fromJSDate(new Date(appt.startTime), { zone: providerTimezone });
            const apptEnd = DateTime.fromJSDate(new Date(appt.endTime), { zone: providerTimezone });

            // Add buffer time
            const bufferedApptStart = apptStart.minus({ minutes: BUFFER_BETWEEN_APPOINTMENTS });
            const bufferedApptEnd = apptEnd.plus({ minutes: BUFFER_BETWEEN_APPOINTMENTS });

            // Check overlap
            // BUG: this overlap check doesn't handle the case where
            // the appointment completely contains the slot, or vice versa
            // It works in most cases but fails for very long appointments
            // overlapping with short slots
            return (slotStart < bufferedApptEnd && slotEnd > bufferedApptStart);
          });

          if (!isOccupied) {
            // Convert to requested timezone for the response
            // BUG: this is where SCHED-278 manifests - we should convert
            // the availability windows BEFORE slicing into slots
            const convertedStart = slotStart.setZone(requestedTimezone);
            const convertedEnd = slotEnd.setZone(requestedTimezone);

            allSlots.push({
              start: convertedStart.toISO()!,
              end: convertedEnd.toISO()!,
              available: true,
            });
          }

          windowStart = windowStart.plus({ minutes: slotDuration });
        }
      }

      current = current.plus({ days: 1 });
    }

    return allSlots;
  }

  /**
   * Check if a provider is available for a specific time range
   */
  async isProviderAvailable(providerId: string, start: Date, end: Date): Promise<boolean> {
    const providerTimezone = await availabilityModel.getProviderTimezone(providerId);

    const startDt = DateTime.fromJSDate(start, { zone: providerTimezone });
    const endDt = DateTime.fromJSDate(end, { zone: providerTimezone });

    const dayOfWeek = startDt.weekday % 7;

    // Check weekly schedule
    const schedule = await availabilityModel.getWeeklySchedule(providerId);
    const daySchedule = schedule.filter(s => s.dayOfWeek === dayOfWeek);

    if (daySchedule.length === 0) {
      return false; // no availability on this day
    }

    // Check if the requested time falls within any availability window
    const isInWindow = daySchedule.some(slot => {
      const [slotStartH, slotStartM] = slot.startTime.split(':').map(Number);
      const [slotEndH, slotEndM] = slot.endTime.split(':').map(Number);

      const windowStart = startDt.startOf('day').set({ hour: slotStartH, minute: slotStartM });
      const windowEnd = startDt.startOf('day').set({ hour: slotEndH, minute: slotEndM });

      return startDt >= windowStart && endDt <= windowEnd;
    });

    if (!isInWindow) return false;

    // Check for overrides
    const dateStr = startDt.toFormat('yyyy-MM-dd');
    const overrides = await availabilityModel.getOverrides(providerId, start, end);
    const override = overrides.find(o => o.overrideDate === dateStr);

    if (override?.overrideType === 'unavailable') {
      return false;
    }

    if (override?.overrideType === 'modified_hours') {
      const [overrideStartH, overrideStartM] = (override.startTime || '09:00').split(':').map(Number);
      const [overrideEndH, overrideEndM] = (override.endTime || '17:00').split(':').map(Number);

      const overrideStart = startDt.startOf('day').set({ hour: overrideStartH, minute: overrideStartM });
      const overrideEnd = startDt.startOf('day').set({ hour: overrideEndH, minute: overrideEndM });

      if (startDt < overrideStart || endDt > overrideEnd) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find the next available slot for a provider
   * Used by the "next available" feature in the UI
   */
  async findNextAvailable(
    providerId: string,
    afterDate: Date,
    durationMinutes: number,
    appointmentType?: string,
  ): Promise<TimeSlot | null> {
    const providerTimezone = await availabilityModel.getProviderTimezone(providerId);

    // Search up to 30 days ahead
    const searchEnd = new Date(afterDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    const slots = await this.getAvailableSlots({
      providerId,
      startDate: afterDate,
      endDate: searchEnd,
      slotDuration: durationMinutes,
      appointmentType,
      providerTimezone,
      requestedTimezone: providerTimezone,
    });

    return slots.length > 0 ? slots[0] : null;
  }

  /**
   * Get appointment statistics for a provider (for dashboards)
   * TODO: cache this in Redis - it's called on every dashboard load
   */
  async getProviderStats(providerId: string, startDate: Date, endDate: Date): Promise<{
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    averageDuration: number;
    utilizationRate: number;
  }> {
    const result = await pool.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE status = 'no_show') as no_show,
        AVG(duration_minutes) FILTER (WHERE status = 'completed') as avg_duration
       FROM appointments
       WHERE provider_id = $1
         AND start_time BETWEEN $2 AND $3`,
      [providerId, startDate, endDate]
    );

    const stats = result.rows[0];

    // Calculate utilization rate
    // (time spent in appointments / total available time)
    // TODO: this is a rough estimate - doesn't account for actual availability hours
    const totalMinutes = (endDate.getTime() - startDate.getTime()) / (1000 * 60);
    const workedMinutes = parseFloat(stats.avg_duration || 0) * parseInt(stats.completed || 0);
    const estimatedAvailableMinutes = totalMinutes * 0.3; // rough estimate: 30% of time is "available"

    return {
      total: parseInt(stats.total) || 0,
      completed: parseInt(stats.completed) || 0,
      cancelled: parseInt(stats.cancelled) || 0,
      noShow: parseInt(stats.no_show) || 0,
      averageDuration: Math.round(parseFloat(stats.avg_duration) || 0),
      utilizationRate: estimatedAvailableMinutes > 0
        ? Math.min(1, workedMinutes / estimatedAvailableMinutes)
        : 0,
    };
  }
}
