/**
 * Identifier generation and validation utilities.
 *
 * Healthcare has a LOT of identifier formats:
 * - MRN (Medical Record Number): internal patient ID
 * - NPI (National Provider Identifier): 10-digit provider ID
 * - Claim numbers: our internal format, not the payer's
 * - Member ID: insurance subscriber ID (format varies by payer)
 * - Group number: insurance group (format varies)
 * - Authorization numbers: from prior auth requests
 *
 * We control the format for MRN, claim numbers, and referral IDs.
 * NPIs are validated against the Luhn algorithm per CMS rules.
 *
 * Format versioning: MRN format changed in v2 (2024). The old format
 * (MRN-XXXXXXXX) still exists in historical data. We accept both.
 */

import { v4 as uuidv4 } from 'uuid';

// --- MRN (Medical Record Number) --------------------------------------------

/**
 * MRN format:
 * v1 (legacy): MRN-XXXXXXXX (8 hex chars) - used before 2024
 * v2 (current): MH-XXXXXXXXXX (10 alphanumeric chars) - current format
 *
 * v2 was introduced to:
 * 1. Avoid collisions as patient base grew
 * 2. Include a check digit for validation
 * 3. Be more human-readable (removed ambiguous chars like 0/O, 1/l)
 */

const MRN_V2_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // No 0, 1, I, O

export function generateMRN(): string {
  // Generate 9 random characters + 1 check digit
  let mrn = 'MH-';
  let checksum = 0;

  for (let i = 0; i < 9; i++) {
    const idx = Math.floor(Math.random() * MRN_V2_CHARS.length);
    mrn += MRN_V2_CHARS[idx];
    checksum += idx * (i + 1);
  }

  // Check digit
  const checkDigit = MRN_V2_CHARS[checksum % MRN_V2_CHARS.length];
  mrn += checkDigit;

  return mrn;
}

export function validateMRN(mrn: string): { valid: boolean; version: number; error?: string } {
  if (!mrn) {
    return { valid: false, version: 0, error: 'MRN is required' };
  }

  // v1 format: MRN-XXXXXXXX
  if (/^MRN-[0-9A-Fa-f]{8}$/.test(mrn)) {
    return { valid: true, version: 1 };
  }

  // v2 format: MH-XXXXXXXXXX
  if (/^MH-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(mrn)) {
    // Validate check digit
    const chars = mrn.substring(3);
    let checksum = 0;
    for (let i = 0; i < 9; i++) {
      checksum += MRN_V2_CHARS.indexOf(chars[i]) * (i + 1);
    }
    const expectedCheckDigit = MRN_V2_CHARS[checksum % MRN_V2_CHARS.length];

    if (chars[9] !== expectedCheckDigit) {
      return { valid: false, version: 2, error: 'Invalid MRN check digit' };
    }

    return { valid: true, version: 2 };
  }

  return { valid: false, version: 0, error: 'MRN does not match any known format' };
}

/**
 * Format an MRN for display (adds visual spacing).
 * MH-XXXX-XXXXXX
 */
export function formatMRN(mrn: string): string {
  if (mrn.startsWith('MH-') && mrn.length === 13) {
    return `${mrn.substring(0, 7)}-${mrn.substring(7)}`;
  }
  return mrn;
}

// --- NPI (National Provider Identifier) -------------------------------------

/**
 * Validate an NPI using the Luhn algorithm.
 *
 * Per CMS rules, NPIs are 10-digit numbers where:
 * - First digit is 1 or 2 (1 for individuals, 2 for organizations)
 * - Last digit is a check digit calculated using Luhn mod 10
 * - The prefix "80840" is used for the Luhn calculation
 *
 * Reference: https://www.cms.gov/Regulations-and-Guidance/Administrative-Simplification/NationalProvIdentStand
 */
export function validateNPI(npi: string): { valid: boolean; type?: 'individual' | 'organization'; error?: string } {
  if (!npi) {
    return { valid: false, error: 'NPI is required' };
  }

  // Must be exactly 10 digits
  if (!/^\d{10}$/.test(npi)) {
    return { valid: false, error: 'NPI must be exactly 10 digits' };
  }

  // First digit must be 1 or 2
  const firstDigit = parseInt(npi[0], 10);
  if (firstDigit !== 1 && firstDigit !== 2) {
    return { valid: false, error: 'NPI must start with 1 (individual) or 2 (organization)' };
  }

  // Luhn check with prefix "80840"
  const prefixedNPI = '80840' + npi;
  let sum = 0;
  let alternate = false;

  for (let i = prefixedNPI.length - 1; i >= 0; i--) {
    let digit = parseInt(prefixedNPI[i], 10);

    if (alternate) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    alternate = !alternate;
  }

  if (sum % 10 !== 0) {
    return { valid: false, error: 'NPI check digit is invalid' };
  }

  return {
    valid: true,
    type: firstDigit === 1 ? 'individual' : 'organization',
  };
}

// --- Claim Numbers -----------------------------------------------------------

/**
 * Claim number format: CLM-{year}{sequence}-{facility}
 * Example: CLM-2026000142-MHC01
 *
 * The sequence resets annually. Facility code is a 5-char identifier
 * for the originating facility.
 */

// Track the last sequence number per year (in production, this is in Redis)
let sequenceCounter: Record<string, number> = {};

export function generateClaimNumber(facilityCode: string): string {
  if (!facilityCode || facilityCode.length !== 5) {
    throw new Error('Facility code must be exactly 5 characters');
  }

  const year = new Date().getFullYear();
  const key = `${year}`;

  if (!sequenceCounter[key]) {
    sequenceCounter[key] = 0;
  }

  sequenceCounter[key]++;
  const sequence = sequenceCounter[key].toString().padStart(6, '0');

  return `CLM-${year}${sequence}-${facilityCode.toUpperCase()}`;
}

export function validateClaimNumber(claimNumber: string): boolean {
  return /^CLM-\d{10}-[A-Z0-9]{5}$/.test(claimNumber);
}

// For testing - reset the sequence counter
export function _resetClaimSequence(): void {
  sequenceCounter = {};
}

// --- Referral IDs ------------------------------------------------------------

/**
 * Referral ID format: REF-{uuid-short}
 * Example: REF-a1b2c3d4
 * Uses the first 8 characters of a UUID v4 for brevity.
 */
export function generateReferralId(): string {
  return `REF-${uuidv4().replace(/-/g, '').substring(0, 8)}`;
}
