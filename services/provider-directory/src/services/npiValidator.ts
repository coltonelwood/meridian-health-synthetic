/**
 * NPI (National Provider Identifier) Validation
 *
 * NPIs are 10-digit numbers assigned by CMS to healthcare providers.
 * They use a variant of the Luhn algorithm (ISO/IEC 7812) for validation.
 *
 * The NPI check digit is calculated using the Luhn formula applied to
 * the 9-digit identifier prepended with the constant prefix "80840"
 * (the health industry identifier from ISO 7812).
 *
 * Reference: https://www.cms.gov/Regulations-and-Guidance/Administrative-Simplification/NationalProvIdentStand/Downloads/NPIcheckdigit.pdf
 *
 * TODO: Add batch validation support for the nightly NPI registry sync.
 * The current implementation validates one at a time which is fine for
 * real-time requests but the sync job processes ~50k NPIs and it'd be
 * nice to validate them more efficiently. Not a priority right now though.
 * - Marcus, 2024-09
 */

/**
 * Validates an NPI number using the Luhn algorithm variant
 * specified by CMS for National Provider Identifiers.
 *
 * @param npi - The NPI number to validate (string of 10 digits)
 * @returns true if the NPI is valid, false otherwise
 */
export function validateNPI(npi: string): boolean {
  // Basic format check
  if (!npi || typeof npi !== 'string') {
    return false;
  }

  // Remove any spaces or dashes (some systems format NPIs with dashes)
  const cleaned = npi.replace(/[\s-]/g, '');

  // Must be exactly 10 digits
  if (!/^\d{10}$/.test(cleaned)) {
    return false;
  }

  // NPI prefix constant for Luhn calculation
  // "80840" is the health industry code per ISO 7812
  const withPrefix = '80840' + cleaned.substring(0, 9);

  // Apply Luhn algorithm
  const checkDigit = parseInt(cleaned[9], 10);
  const calculated = calculateLuhnCheckDigit(withPrefix);

  return checkDigit === calculated;
}

/**
 * Calculates the Luhn check digit for a numeric string.
 *
 * The Luhn algorithm:
 * 1. Starting from the rightmost digit, double every second digit
 * 2. If doubling results in a number > 9, subtract 9
 * 3. Sum all digits
 * 4. Check digit is (10 - (sum mod 10)) mod 10
 */
function calculateLuhnCheckDigit(numberStr: string): number {
  const digits = numberStr.split('').map(Number);
  let sum = 0;

  // Process from right to left
  // Double every second digit starting from the rightmost
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits[i];
    const position = digits.length - 1 - i;

    // Double digits at even positions (0, 2, 4, ...)
    if (position % 2 === 0) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * Determines the NPI type based on the enumeration type.
 * Type 1: Individual providers (physicians, nurses, etc.)
 * Type 2: Organization providers (hospitals, clinics, etc.)
 *
 * Note: You can't actually tell the type from the NPI number itself -
 * you have to look it up in the NPPES registry. This function is a
 * placeholder for when we implement the registry lookup.
 */
export function getNPIType(npi: string): 1 | 2 | null {
  if (!validateNPI(npi)) {
    return null;
  }
  // Can't determine type from number alone
  // TODO: implement NPPES API lookup (PLAT-4501)
  return null;
}

/**
 * Formats an NPI for display
 * Some systems show NPIs as "1234567890" and others as "123-456-7890"
 * We use the unformatted version but this helper exists for display
 */
export function formatNPI(npi: string): string {
  const cleaned = npi.replace(/[\s-]/g, '');
  if (cleaned.length !== 10) return npi;
  // just return as-is, we decided against formatted display
  return cleaned;
}

/**
 * Generates a valid random NPI for testing purposes.
 * DO NOT use in production - these won't correspond to real providers.
 */
export function generateTestNPI(): string {
  // Generate 9 random digits
  let npi = '';
  for (let i = 0; i < 9; i++) {
    npi += Math.floor(Math.random() * 10).toString();
  }

  // Calculate and append check digit
  const withPrefix = '80840' + npi;
  const checkDigit = calculateLuhnCheckDigit(withPrefix);
  npi += checkDigit.toString();

  return npi;
}
