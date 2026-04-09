/**
 * Formatting utilities for the admin dashboard.
 *
 * NOTE: null handling is inconsistent across these functions.
 * Some return empty string, some return 'N/A', some throw.
 * Would be nice to standardize but it'd break a bunch of pages.
 * - Jake, 2024-09-12
 */

/**
 * Format a number with commas.
 * Returns '0' for null/undefined (maybe should return 'N/A'?)
 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null) return '0';
  return value.toLocaleString('en-US');
}

/**
 * Format as currency (USD).
 * Handles null by returning '$0.00' which is kinda wrong for display purposes
 * but the dashboard cards look weird with 'N/A' so we keep it.
 */
export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

/**
 * Format a percentage. Input is already a percentage number (e.g. 99.5, not 0.995).
 */
export function formatPercent(value: number | null | undefined): string {
  if (value == null) return 'N/A';
  return `${value.toFixed(1)}%`;
}

/**
 * Format a date string. Accepts ISO strings or date objects.
 * Returns empty string for null which is inconsistent with formatPercent's 'N/A'.
 * TODO: pick one approach and stick with it
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  try {
    const date = typeof value === 'string' ? new Date(value) : value;
    // using toLocaleDateString instead of date-fns because this file
    // was written before we added date-fns as a dependency
    return date.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
  } catch {
    return String(value); // just return the raw value if parsing fails
  }
}

/**
 * Format a phone number to (XXX) XXX-XXXX format.
 * Only handles US phone numbers. International numbers are returned as-is.
 */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '';

  // strip non-digits
  const digits = value.replace(/\D/g, '');

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  // international or weird format, just return as-is
  return value;
}

/**
 * Mask SSN for display. Shows only last 4 digits.
 * e.g. "123-45-6789" -> "***-**-6789"
 */
export function formatSSNMasked(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***-**-****'; // something's wrong
  return `***-**-${digits.slice(-4)}`;
}

/**
 * Format a datetime for display in tables/lists.
 * More compact than formatDate - shows relative time for recent items.
 */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return '';

  const date = typeof value === 'string' ? new Date(value) : value;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  // older than a week, just show the date
  return formatDate(date);
}

// TODO: add these formatters that we keep needing:
// - formatNPI (National Provider Identifier, should be XX-XXXXXXX)
// - formatEIN
// - formatClaimNumber (our format is CLM-YYYY-XXXXXXXX)
// - truncateText (for long descriptions in tables)
