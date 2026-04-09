import {
  formatDate,
  parseDate,
  calculateAge,
  isValidDate,
  daysBetween,
  businessDaysBetween,
  dateRange,
  toUTC,
  toTimezone,
} from '../src/dates';

describe('formatDate', () => {
  it('should format a Date object to YYYY-MM-DD by default', () => {
    expect(formatDate(new Date(2026, 0, 15))).toBe('2026-01-15');
  });

  it('should format an ISO string to YYYY-MM-DD', () => {
    expect(formatDate('2026-06-30T14:30:00Z')).toBe('2026-06-30');
  });

  it('should format with custom format string', () => {
    expect(formatDate('2026-03-15', 'MM/dd/yyyy')).toBe('03/15/2026');
  });

  it('should throw for invalid date', () => {
    expect(() => formatDate('not-a-date')).toThrow('Invalid date');
  });
});

describe('parseDate', () => {
  it('should parse ISO 8601 date strings', () => {
    const result = parseDate('2026-01-15');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2026);
    expect(result!.getMonth()).toBe(0); // January
    expect(result!.getDate()).toBe(15);
  });

  it('should parse ISO 8601 datetime strings', () => {
    const result = parseDate('2026-01-15T10:30:00Z');
    expect(result).toBeInstanceOf(Date);
  });

  it('should parse US format dates (MM/DD/YYYY)', () => {
    const result = parseDate('01/15/2026');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2026);
  });

  it('should parse EDI format dates (YYYYMMDD)', () => {
    const result = parseDate('20260115');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2026);
    expect(result!.getMonth()).toBe(0);
    expect(result!.getDate()).toBe(15);
  });

  it('should return null for invalid dates', () => {
    expect(parseDate('garbage')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('2026-13-45')).toBeNull();
  });

  it('should parse with explicit format', () => {
    const result = parseDate('15-01-2026', 'dd-MM-yyyy');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getDate()).toBe(15);
  });
});

describe('calculateAge', () => {
  it('should calculate age correctly', () => {
    // Person born on Jan 1, 1990, checked on Jan 1, 2026 = 36 years old
    expect(calculateAge('1990-01-01', '2026-01-01')).toBe(36);
  });

  it('should return 0 for newborns', () => {
    expect(calculateAge('2026-01-01', '2026-06-15')).toBe(0);
  });

  it('should handle birthday not yet occurred this year', () => {
    // Born Dec 31, 1990, checked Jan 1, 2026 = 35 (birthday hasn't happened)
    expect(calculateAge('1990-12-31', '2026-01-01')).toBe(35);
  });

  it('should handle leap year birthdays (Feb 29)', () => {
    // Born Feb 29, 2000 (leap year)
    // On Feb 28, 2026 (non-leap year) = 25
    expect(calculateAge('2000-02-29', '2026-02-28')).toBe(25);
    // On Mar 1, 2026 = 26
    expect(calculateAge('2000-02-29', '2026-03-01')).toBe(26);
  });

  it('should use current date when asOfDate is not provided', () => {
    const age = calculateAge('2000-01-01');
    expect(age).toBeGreaterThanOrEqual(26); // Will be at least 26 as of 2026
  });

  it('should throw for future date of birth', () => {
    expect(() => calculateAge('2030-01-01', '2026-01-01')).toThrow(
      'Date of birth cannot be in the future'
    );
  });

  it('should throw for invalid date of birth', () => {
    expect(() => calculateAge('not-a-date')).toThrow('Invalid date of birth');
  });

  // Healthcare-specific age boundary tests
  it('should correctly identify pediatric patients (< 18)', () => {
    const age = calculateAge('2010-06-15', '2026-06-14');
    expect(age).toBe(15); // Not yet 16
  });

  it('should correctly identify Medicare eligibility (>= 65)', () => {
    const age = calculateAge('1961-01-01', '2026-01-01');
    expect(age).toBe(65);
  });

  it('should correctly identify ACA dependent cutoff (< 26)', () => {
    const age = calculateAge('2000-03-15', '2026-03-14');
    expect(age).toBe(25); // Still covered as dependent
    const ageAfter = calculateAge('2000-03-15', '2026-03-15');
    expect(ageAfter).toBe(26); // No longer covered
  });
});

describe('isValidDate', () => {
  it('should return true for valid ISO dates', () => {
    expect(isValidDate('2026-01-15')).toBe(true);
    expect(isValidDate('2026-01-15T10:30:00Z')).toBe(true);
  });

  it('should return true for valid US format dates', () => {
    expect(isValidDate('01/15/2026')).toBe(true);
  });

  it('should return false for invalid dates', () => {
    expect(isValidDate('')).toBe(false);
    expect(isValidDate('garbage')).toBe(false);
  });
});

describe('daysBetween', () => {
  it('should calculate days between two dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });

  it('should return 0 for the same date', () => {
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('should handle reverse order (always positive)', () => {
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(30);
  });
});

describe('businessDaysBetween', () => {
  it('should exclude weekends', () => {
    // Mon Jan 5 to Fri Jan 9 = 4 business days
    expect(businessDaysBetween('2026-01-05', '2026-01-09')).toBe(4);
  });

  it('should handle a full week', () => {
    // Mon to next Mon = 5 business days
    expect(businessDaysBetween('2026-01-05', '2026-01-12')).toBe(5);
  });

  it('should return 0 for same day', () => {
    expect(businessDaysBetween('2026-01-05', '2026-01-05')).toBe(0);
  });

  it('should handle weekends only', () => {
    // Saturday to Sunday = 0 business days
    expect(businessDaysBetween('2026-01-10', '2026-01-11')).toBe(0);
  });

  it('should handle negative direction', () => {
    expect(businessDaysBetween('2026-01-09', '2026-01-05')).toBe(-4);
  });

  it('should handle longer periods (claims timely filing)', () => {
    // 90 calendar days should be approximately 64 business days
    const result = businessDaysBetween('2026-01-01', '2026-04-01');
    expect(result).toBeGreaterThan(60);
    expect(result).toBeLessThan(70);
  });
});

describe('dateRange', () => {
  it('should generate an array of dates', () => {
    const range = dateRange('2026-01-01', '2026-01-05');
    expect(range).toHaveLength(5);
  });

  it('should include start and end dates', () => {
    const range = dateRange('2026-01-01', '2026-01-03');
    expect(formatDate(range[0])).toBe('2026-01-01');
    expect(formatDate(range[range.length - 1])).toBe('2026-01-03');
  });

  it('should throw if start is after end', () => {
    expect(() => dateRange('2026-01-05', '2026-01-01')).toThrow(
      'Start date must be before end date'
    );
  });
});

describe('timezone conversions', () => {
  it('should convert to UTC from Eastern', () => {
    // 10:00 AM Eastern = 15:00 UTC (during EST, not EDT)
    const utcDate = toUTC('2026-01-15T10:00:00', 'America/New_York');
    expect(utcDate.getUTCHours()).toBe(15);
  });

  it('should convert from UTC to Eastern', () => {
    const easternDate = toTimezone('2026-01-15T15:00:00Z', 'America/New_York');
    // The returned Date object represents the time in Eastern
    expect(easternDate.getHours()).toBe(10);
  });
});
