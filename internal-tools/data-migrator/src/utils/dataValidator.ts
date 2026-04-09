/**
 * Data validation for migrated healthcare records.
 *
 * These validators are intentionally strict because bad data in a healthcare
 * system can have real consequences (wrong patient, wrong billing, etc).
 * Better to reject and fix than to import garbage.
 */

export class ValidationError extends Error {
  public field: string;
  public value: any;

  constructor(field: string, message: string, value?: any) {
    super(`${field}: ${message}`);
    this.field = field;
    this.value = value;
  }
}

/**
 * Validate a patient record before insertion.
 */
export function validatePatient(data: Record<string, any>): void {
  // Required fields
  if (!data.first_name || data.first_name.trim() === '') {
    throw new ValidationError('first_name', 'First name is required');
  }
  if (!data.last_name || data.last_name.trim() === '') {
    throw new ValidationError('last_name', 'Last name is required');
  }
  if (!data.date_of_birth) {
    throw new ValidationError('date_of_birth', 'Date of birth is required');
  }

  // Name validation
  if (data.first_name.length > 100) {
    throw new ValidationError('first_name', 'First name too long (max 100 chars)', data.first_name);
  }
  if (data.last_name.length > 100) {
    throw new ValidationError('last_name', 'Last name too long (max 100 chars)', data.last_name);
  }

  // check for obvious test/fake data
  const suspiciousNames = ['TEST', 'FAKE', 'DUMMY', 'SAMPLE', 'XXXX', 'ZZZZ', 'ASDF', 'DELETE ME'];
  if (suspiciousNames.includes(data.first_name.toUpperCase()) ||
      suspiciousNames.includes(data.last_name.toUpperCase())) {
    throw new ValidationError('name', 'Suspected test data', `${data.first_name} ${data.last_name}`);
  }

  // DOB validation
  if (data.date_of_birth) {
    const dob = new Date(data.date_of_birth);
    if (isNaN(dob.getTime())) {
      throw new ValidationError('date_of_birth', 'Invalid date format', data.date_of_birth);
    }

    const now = new Date();
    const age = (now.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

    if (dob > now) {
      throw new ValidationError('date_of_birth', 'Date of birth is in the future', data.date_of_birth);
    }
    if (age > 130) {
      throw new ValidationError('date_of_birth', 'Patient would be over 130 years old', data.date_of_birth);
    }
    // extremely young patients (< 1 day old) in legacy data are usually data errors
    // real neonatal records would have been entered in the current system
    if (age < 0.003) { // ~1 day
      throw new ValidationError('date_of_birth', 'Suspiciously recent DOB for legacy data', data.date_of_birth);
    }
  }

  // SSN validation (if provided)
  if (data.ssn) {
    if (!/^\d{9}$/.test(data.ssn)) {
      throw new ValidationError('ssn', 'SSN must be exactly 9 digits', data.ssn);
    }
    // SSA doesn't issue SSNs starting with 9 (except for ITIN)
    // or 000, and area numbers 666 were never issued
    if (data.ssn.startsWith('000') || data.ssn.startsWith('666')) {
      throw new ValidationError('ssn', 'Invalid SSN prefix', data.ssn);
    }
    // check for obviously fake SSNs used in testing
    if (data.ssn.startsWith('987654') || data.ssn === '078051120') {
      throw new ValidationError('ssn', 'Known test/fake SSN', data.ssn);
    }
  }

  // Email validation (basic)
  if (data.email) {
    // don't use a complex regex, just check the basics
    if (!data.email.includes('@') || !data.email.includes('.')) {
      throw new ValidationError('email', 'Invalid email format', data.email);
    }
    // check for internal test emails
    if (data.email.endsWith('@test.com') || data.email.endsWith('@example.com')) {
      // don't reject these, just warn - some legacy records actually have these
      // TODO: should we strip these? For now leave them
    }
  }

  // Phone validation (if provided)
  if (data.phone) {
    if (!/^\d{10}$/.test(data.phone)) {
      throw new ValidationError('phone', 'Phone must be 10 digits after cleaning', data.phone);
    }
    // check for fake phone numbers
    if (data.phone.startsWith('555') && data.phone !== '5551234567') {
      // 555 numbers are traditionally fake... but some real people have them
      // in the 555-0100 to 555-0199 range. Not blocking, just noting.
    }
  }

  // State validation
  if (data.state) {
    const validStates = [
      'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
      'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
      'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
      'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
      'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
      'DC', 'PR', 'GU', 'VI', 'AS', 'MP',
    ];
    if (!validStates.includes(data.state.toUpperCase())) {
      throw new ValidationError('state', 'Invalid state code', data.state);
    }
  }

  // ZIP validation
  if (data.zip_code) {
    if (!/^\d{5}$/.test(data.zip_code)) {
      throw new ValidationError('zip_code', 'ZIP code must be 5 digits', data.zip_code);
    }
  }

  // Gender validation
  if (data.gender) {
    const validGenders = ['male', 'female', 'other', 'unknown'];
    if (!validGenders.includes(data.gender)) {
      throw new ValidationError('gender', 'Invalid gender value', data.gender);
    }
  }
}

/**
 * Validate a claim record before insertion.
 */
export function validateClaim(data: Record<string, any>): void {
  // claim_number is required
  if (!data.claim_number || data.claim_number.trim() === '') {
    throw new ValidationError('claim_number', 'Claim number is required');
  }

  // service date is required
  if (!data.service_date) {
    throw new ValidationError('service_date', 'Service date is required');
  }

  // validate service date range
  if (data.service_date) {
    const svcDate = new Date(data.service_date);
    if (isNaN(svcDate.getTime())) {
      throw new ValidationError('service_date', 'Invalid date format', data.service_date);
    }

    // claims before 2000 are probably data errors in the context of this migration
    if (svcDate < new Date('2000-01-01')) {
      throw new ValidationError('service_date', 'Service date before 2000 is suspicious', data.service_date);
    }

    // future dates are wrong
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (svcDate > tomorrow) {
      throw new ValidationError('service_date', 'Service date is in the future', data.service_date);
    }
  }

  // service end date should be >= start date
  if (data.service_date && data.service_date_end) {
    if (new Date(data.service_date_end) < new Date(data.service_date)) {
      throw new ValidationError('service_date_end', 'End date before start date');
    }
  }

  // Amount validation
  if (data.billed_amount != null) {
    if (typeof data.billed_amount !== 'number' || data.billed_amount < 0) {
      throw new ValidationError('billed_amount', 'Billed amount must be a non-negative number', data.billed_amount);
    }
    if (data.billed_amount > 10_000_000) {
      // $10M+ claims are almost certainly data errors
      throw new ValidationError('billed_amount', 'Billed amount suspiciously high (>$10M)', data.billed_amount);
    }
  }

  // Diagnosis code validation (ICD-10 format)
  for (const field of ['diagnosis_code_1', 'diagnosis_code_2', 'diagnosis_code_3', 'diagnosis_code_4']) {
    if (data[field]) {
      // ICD-10 codes are 3-7 alphanumeric characters
      // starting with a letter (A-Z) followed by digits
      // with an optional period after the 3rd character
      const code = data[field].replace(/\./g, '');
      if (!/^[A-TV-Z]\d{2,6}$/i.test(code)) {
        // might be ICD-9 (pre-2015 data) - those are 3-5 digits with optional decimal
        if (!/^\d{3,5}$/i.test(code) && !/^[VE]\d{2,4}$/i.test(code)) {
          throw new ValidationError(field, 'Invalid diagnosis code format', data[field]);
        }
        // ICD-9 codes are valid but we should note them
        // TODO: add a flag to the record indicating it has ICD-9 codes
      }
    }
  }

  // CPT/HCPCS code validation
  if (data.procedure_code_1) {
    const code = data.procedure_code_1.trim();
    // CPT codes are 5 digits, HCPCS codes are 1 letter + 4 digits
    if (!/^(\d{5}|[A-V]\d{4})$/.test(code)) {
      throw new ValidationError('procedure_code_1', 'Invalid CPT/HCPCS code format', code);
    }
  }

  // Place of service validation - should be 2-digit CMS code
  if (data.place_of_service) {
    const pos = data.place_of_service;
    if (!/^\d{2}$/.test(pos)) {
      throw new ValidationError('place_of_service', 'Place of service must be 2-digit code', pos);
    }
    // valid POS codes are 01-99 but only certain ones are actually used
    const posNum = parseInt(pos);
    const validPOS = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 31, 32, 33, 34, 41, 42, 49, 50, 51, 52, 53, 54,
      55, 56, 57, 58, 60, 61, 62, 65, 71, 72, 81, 99,
    ];
    if (!validPOS.includes(posNum)) {
      // don't throw, just warn - CMS adds new codes and we might be behind
      console.warn(`Unusual place of service code: ${pos}`);
    }
  }

  // Provider NPI validation
  if (data.provider_npi) {
    if (!validateNPI(data.provider_npi)) {
      throw new ValidationError('provider_npi', 'Invalid NPI format', data.provider_npi);
    }
  }
}

/**
 * Validate a National Provider Identifier (NPI).
 *
 * NPI is a 10-digit number where the last digit is a check digit
 * calculated using the Luhn algorithm (with a prefix of 80840).
 *
 * Reference: https://www.cms.gov/Regulations-and-Guidance/Administrative-Simplification/NationalProvIdentStand
 */
export function validateNPI(npi: string): boolean {
  if (!npi) return false;

  // must be exactly 10 digits
  const cleaned = npi.replace(/\D/g, '');
  if (cleaned.length !== 10) return false;

  // Luhn check with 80840 prefix
  // The full number to validate is 80840 + the 10-digit NPI
  const fullNumber = '80840' + cleaned;
  let sum = 0;
  let alternate = false;

  for (let i = fullNumber.length - 1; i >= 0; i--) {
    let digit = parseInt(fullNumber[i]);

    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

/**
 * Validate a DEA number format.
 * DEA numbers have the format: 2 letters + 7 digits
 * where the first letter indicates registrant type and
 * the last digit is a check digit.
 *
 * TODO: implement the check digit validation
 */
export function validateDEA(dea: string): boolean {
  if (!dea) return false;
  // basic format check for now
  return /^[A-Z]{2}\d{7}$/.test(dea.toUpperCase());
}
