/**
 * Date utility functions for Meridian Health services.
 *
 * IMPORTANT: All dates in the system should be stored as UTC.
 * Display timezone conversion should happen at the edge (API response
 * or frontend). Internal service communication always uses UTC ISO 8601.
 *
 * Healthcare-specific considerations:
 * - Age calculation from DOB is used for pediatric/geriatric protocols
 * - Date of birth edge cases around Feb 29 matter for patient matching
 * - Business day calculations are needed for claims timely filing
 * - Some payer APIs use date-only strings (YYYY-MM-DD) vs full ISO 8601
 */

import {
  format,
  parse,
  differenceInDays,
  differenceInYears,
  addDays,
  addMonths,
  isValid,
  parseISO,
  startOfDay,
  endOfDay,
  isBefore,
  isAfter,
  isWeekend,
  eachDayOfInterval,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

/**
 * Format a date to a string in the specified format.
 * Defaults to ISO 8601 date-only format (YYYY-MM-DD), which is what
 * most healthcare systems expect.
 */
export function formatDate(
  date: Date | string,
  formatStr: string = 'yyyy-MM-dd'
): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  if (!isValid(d)) {
    throw new Error(`Invalid date: ${date}`);
  }
  return format(d, formatStr);
}

/**
 * Parse a date string in a given format. Returns null if invalid.
 * Handles common healthcare date formats:
 * - YYYY-MM-DD (ISO 8601 date)
 * - MM/DD/YYYY (US format, common in patient-facing forms)
 * - YYYYMMDD (X12/EDI format)
 */
export function parseDate(dateStr: string, formatStr?: string): Date | null {
  if (!dateStr) return null;

  // Auto-detect format if not specified
  if (!formatStr) {
    // ISO 8601 full datetime
    if (dateStr.includes('T')) {
      const d = parseISO(dateStr);
      return isValid(d) ? d : null;
    }
    // YYYYMMDD (EDI format)
    if (/^\d{8}$/.test(dateStr)) {
      formatStr = 'yyyyMMdd';
    }
    // MM/DD/YYYY
    else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
      formatStr = 'M/d/yyyy';
    }
    // YYYY-MM-DD
    else if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const d = parseISO(dateStr);
      return isValid(d) ? d : null;
    }
    else {
      return null;
    }
  }

  try {
    const d = parse(dateStr, formatStr, new Date());
    return isValid(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Convert a date to UTC.
 */
export function toUTC(date: Date | string, sourceTimezone: string): Date {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return fromZonedTime(d, sourceTimezone);
}

/**
 * Convert a UTC date to a specific timezone.
 */
export function toTimezone(date: Date | string, timezone: string): Date {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return toZonedTime(d, timezone);
}

/**
 * Generate an array of dates between start and end (inclusive).
 */
export function dateRange(start: Date | string, end: Date | string): Date[] {
  const startDate = typeof start === 'string' ? parseISO(start) : start;
  const endDate = typeof end === 'string' ? parseISO(end) : end;

  if (isAfter(startDate, endDate)) {
    throw new Error('Start date must be before end date');
  }

  return eachDayOfInterval({ start: startDate, end: endDate });
}

/**
 * Calculate age from date of birth.
 *
 * Healthcare-specific edge cases:
 * - Leap year birthdays (Feb 29): Age increments on March 1 in non-leap years
 * - Newborns: Returns 0
 * - Future DOB: Throws an error (data quality issue)
 *
 * This is used for:
 * - Pediatric vs adult protocol determination
 * - Geriatric screening triggers (age >= 65)
 * - Insurance dependent coverage cutoff (age 26 for ACA)
 * - Medicare eligibility (age 65)
 */
export function calculateAge(dob: Date | string, asOfDate?: Date | string): number {
  const birthDate = typeof dob === 'string' ? parseISO(dob) : dob;
  const referenceDate = asOfDate
    ? (typeof asOfDate === 'string' ? parseISO(asOfDate) : asOfDate)
    : new Date();

  if (!isValid(birthDate)) {
    throw new Error(`Invalid date of birth: ${dob}`);
  }

  if (isAfter(birthDate, referenceDate)) {
    throw new Error('Date of birth cannot be in the future');
  }

  return differenceInYears(referenceDate, birthDate);
}

/**
 * Check if a date string is valid.
 */
export function isValidDate(dateStr: string): boolean {
  if (!dateStr) return false;

  // Try ISO parse first
  const d = parseISO(dateStr);
  if (isValid(d)) return true;

  // Try common formats
  return parseDate(dateStr) !== null;
}

/**
 * Calculate the number of calendar days between two dates.
 */
export function daysBetween(start: Date | string, end: Date | string): number {
  const startDate = typeof start === 'string' ? parseISO(start) : start;
  const endDate = typeof end === 'string' ? parseISO(end) : end;
  return Math.abs(differenceInDays(endDate, startDate));
}

/**
 * Calculate the number of business days between two dates.
 *
 * Used for:
 * - Claims timely filing calculations
 * - Credentialing process SLAs
 * - Prior authorization response deadlines
 *
 * NOTE: This does NOT account for federal holidays. We should add
 * a holiday calendar, but it's complicated because different payers
 * observe different holidays. For now, this is "good enough" for
 * most use cases.
 *
 * TODO: Add federal holiday support. Consider using a holiday API
 * or a static holiday list that gets updated annually.
 */
export function businessDaysBetween(
  start: Date | string,
  end: Date | string
): number {
  const startDate = startOfDay(typeof start === 'string' ? parseISO(start) : start);
  const endDate = startOfDay(typeof end === 'string' ? parseISO(end) : end);

  if (isAfter(startDate, endDate)) {
    return -businessDaysBetween(end, start);
  }

  let count = 0;
  let current = addDays(startDate, 1); // Start from the next day

  while (isBefore(current, endDate) || current.getTime() === endDate.getTime()) {
    if (!isWeekend(current)) {
      count++;
    }
    current = addDays(current, 1);
  }

  return count;
}
