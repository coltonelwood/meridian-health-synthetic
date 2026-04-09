/**
 * Log formatters and PHI redaction utilities.
 *
 * The redaction system is the last line of defense against PHI leaking
 * into logs. Even if a developer accidentally passes PHI to the logger,
 * these formatters will catch and redact it.
 *
 * The redaction list is configurable per service (some services handle
 * more PHI fields than others), but there's a default list that covers
 * the most common PHI fields.
 */

// Default redaction placeholder
const REDACTED = '[REDACTED]';

// Patterns that look like PHI even if the field name doesn't match
const PHI_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'SSN', regex: /\b\d{3}-?\d{2}-?\d{4}\b/ },
  { name: 'Phone', regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/ },
  { name: 'Email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/ },
  // MRN patterns (our internal formats)
  { name: 'MRN_v1', regex: /\bMRN-[0-9A-Fa-f]{8}\b/ },
  { name: 'MRN_v2', regex: /\bMH-[A-Z0-9]{10}\b/ },
];

/**
 * Redact sensitive fields from a metadata object.
 * This is applied to every log entry before it's written.
 *
 * The function is recursive - it handles nested objects and arrays.
 */
export function redactSensitiveFields(
  obj: Record<string, any>,
  redactedFields: string[]
): Record<string, any> {
  if (!obj || typeof obj !== 'object') return obj;

  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Check if the field name matches a redacted field (case-insensitive)
    const keyLower = key.toLowerCase();
    const shouldRedact = redactedFields.some(
      field => keyLower === field.toLowerCase() || keyLower.includes(field.toLowerCase())
    );

    if (shouldRedact) {
      result[key] = REDACTED;
      continue;
    }

    // Recursively handle nested objects
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[key] = redactSensitiveFields(value, redactedFields);
      continue;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'object' && item !== null) {
          return redactSensitiveFields(item, redactedFields);
        }
        // Check string values for PHI patterns
        if (typeof item === 'string') {
          return redactStringPatterns(item);
        }
        return item;
      });
      continue;
    }

    // Check string values for PHI patterns
    if (typeof value === 'string') {
      result[key] = redactStringPatterns(value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Check a string value for PHI patterns and redact them.
 * This catches cases where PHI is embedded in a non-sensitive field.
 *
 * Example: A log message like "Processing patient with SSN 123-45-6789"
 * would have the SSN redacted even though the field name isn't "ssn".
 */
function redactStringPatterns(value: string): string {
  let result = value;

  for (const pattern of PHI_PATTERNS) {
    if (pattern.regex.test(result)) {
      result = result.replace(pattern.regex, `[${pattern.name}_REDACTED]`);
    }
  }

  return result;
}

/**
 * Format a log entry for structured JSON output.
 * This is the format used for production logs that get ingested
 * by our log aggregation system (currently Datadog).
 */
export function formatLogEntry(
  level: string,
  message: string,
  service: string,
  meta: Record<string, any>
): Record<string, any> {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    service,
    ...meta,
    // Ensure these fields are always present for log aggregation
    _app: 'meridian-health',
    _version: '1', // log format version
  };
}
