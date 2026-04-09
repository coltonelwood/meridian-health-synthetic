import { validate, IsNotEmpty, IsEmail, IsOptional, Length, Matches } from 'class-validator';

/**
 * Input validation helpers for patient data.
 *
 * This file is a mess - some validators use regex, some use class-validator,
 * and some are just inline checks. We should pick one approach and stick with it.
 *
 * The plan was to use class-validator DTOs for everything but that never
 * got fully implemented so we have this hybrid approach.
 */

// ============================================================
// Simple regex-based validators (the old way)
// ============================================================

// MRN format: MRN-XXXXXXXX (8 digits)
const MRN_REGEX = /^MRN-\d{8}$/;

// US phone number formats: (xxx) xxx-xxxx, xxx-xxx-xxxx, xxxxxxxxxx
const PHONE_REGEX = /^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/;

// SSN format: xxx-xx-xxxx or xxxxxxxxx
const SSN_REGEX = /^(?!000|666|9\d{2})\d{3}-?(?!00)\d{2}-?(?!0000)\d{4}$/;

// Date format: YYYY-MM-DD
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ZIP code: 5 digits or 5+4
const ZIP_REGEX = /^\d{5}(-\d{4})?$/;

// Email - yeah this isn't perfect but close enough
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// State abbreviation
const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'AS', 'MP', // territories
];

const VALID_GENDERS = ['male', 'female', 'other', 'unknown', 'M', 'F', 'U']; // include legacy codes
const VALID_MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'separated', 'domestic-partner', 'unknown'];
const VALID_CONTACT_METHODS = ['phone', 'email', 'mail', 'portal'];
const VALID_ETHNICITIES = ['hispanic-or-latino', 'not-hispanic-or-latino', 'unknown', 'declined'];

export function validateMRN(mrn: string): boolean {
  return MRN_REGEX.test(mrn);
}

export function validatePhone(phone: string): boolean {
  return PHONE_REGEX.test(phone);
}

export function validateSSN(ssn: string): boolean {
  return SSN_REGEX.test(ssn);
}

export function validateDate(date: string): boolean {
  if (!DATE_REGEX.test(date)) return false;

  // Also check it's a valid date
  const parsed = new Date(date);
  return !isNaN(parsed.getTime());
}

export function validateZipCode(zip: string): boolean {
  return ZIP_REGEX.test(zip);
}

export function validateState(state: string): boolean {
  return US_STATES.includes(state.toUpperCase());
}

export function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

// ============================================================
// Patient input validation (the main one used by routes)
// ============================================================

export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

/**
 * Validate patient creation/update input
 *
 * @param data - the request body
 * @param isPartial - if true, skip required field checks (for PATCH/partial updates)
 * @returns array of validation errors (empty if valid)
 */
export function validatePatientInput(data: any, isPartial = false): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required fields (only for creation / full update)
  if (!isPartial) {
    if (!data.firstName || typeof data.firstName !== 'string' || data.firstName.trim().length === 0) {
      errors.push({ field: 'firstName', message: 'First name is required' });
    }

    if (!data.lastName || typeof data.lastName !== 'string' || data.lastName.trim().length === 0) {
      errors.push({ field: 'lastName', message: 'Last name is required' });
    }

    if (!data.dateOfBirth) {
      errors.push({ field: 'dateOfBirth', message: 'Date of birth is required' });
    }

    if (!data.gender) {
      errors.push({ field: 'gender', message: 'Gender is required' });
    }
  }

  // Validate fields if present
  if (data.firstName && data.firstName.length > 100) {
    errors.push({ field: 'firstName', message: 'First name must be 100 characters or less' });
  }

  if (data.lastName && data.lastName.length > 100) {
    errors.push({ field: 'lastName', message: 'Last name must be 100 characters or less' });
  }

  if (data.middleName && data.middleName.length > 100) {
    errors.push({ field: 'middleName', message: 'Middle name must be 100 characters or less' });
  }

  if (data.dateOfBirth) {
    if (!validateDate(data.dateOfBirth)) {
      errors.push({ field: 'dateOfBirth', message: 'Date of birth must be in YYYY-MM-DD format' });
    } else {
      // Check that DOB is not in the future
      const dob = new Date(data.dateOfBirth);
      if (dob > new Date()) {
        errors.push({ field: 'dateOfBirth', message: 'Date of birth cannot be in the future' });
      }
      // Check that DOB is not impossibly old
      const maxAge = new Date();
      maxAge.setFullYear(maxAge.getFullYear() - 130);
      if (dob < maxAge) {
        errors.push({ field: 'dateOfBirth', message: 'Date of birth seems unreasonably old' });
      }
    }
  }

  if (data.gender && !VALID_GENDERS.includes(data.gender)) {
    errors.push({
      field: 'gender',
      message: `Gender must be one of: ${VALID_GENDERS.join(', ')}`,
      value: data.gender,
    });
  }

  if (data.ssn && !validateSSN(data.ssn)) {
    errors.push({ field: 'ssn', message: 'Invalid SSN format' });
  }

  if (data.email && !validateEmail(data.email)) {
    errors.push({ field: 'email', message: 'Invalid email format' });
  }

  if (data.homePhone && !validatePhone(data.homePhone)) {
    errors.push({ field: 'homePhone', message: 'Invalid phone number format' });
  }

  if (data.mobilePhone && !validatePhone(data.mobilePhone)) {
    errors.push({ field: 'mobilePhone', message: 'Invalid phone number format' });
  }

  if (data.workPhone && !validatePhone(data.workPhone)) {
    errors.push({ field: 'workPhone', message: 'Invalid phone number format' });
  }

  if (data.mrn && !validateMRN(data.mrn)) {
    errors.push({ field: 'mrn', message: 'MRN must be in format MRN-XXXXXXXX' });
  }

  if (data.maritalStatus && !VALID_MARITAL_STATUSES.includes(data.maritalStatus)) {
    errors.push({ field: 'maritalStatus', message: `Invalid marital status: ${data.maritalStatus}` });
  }

  if (data.preferredContactMethod && !VALID_CONTACT_METHODS.includes(data.preferredContactMethod)) {
    errors.push({ field: 'preferredContactMethod', message: `Invalid contact method: ${data.preferredContactMethod}` });
  }

  if (data.ethnicity && !VALID_ETHNICITIES.includes(data.ethnicity)) {
    errors.push({ field: 'ethnicity', message: `Invalid ethnicity value: ${data.ethnicity}` });
  }

  // Race validation (if it's an array)
  if (data.race) {
    if (!Array.isArray(data.race)) {
      errors.push({ field: 'race', message: 'Race must be an array' });
    }
    // TODO: validate individual race values against OMB categories
  }

  // Validate preferred language is a valid ISO 639-1 code
  // ...actually we don't validate this, we just accept whatever
  // TODO: validate language code (PLAT-3300)

  return errors;
}

// ============================================================
// Address validation
// ============================================================

export function validateAddress(data: any): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data.line1 || data.line1.trim().length === 0) {
    errors.push({ field: 'line1', message: 'Address line 1 is required' });
  }

  if (!data.city || data.city.trim().length === 0) {
    errors.push({ field: 'city', message: 'City is required' });
  }

  if (!data.state) {
    errors.push({ field: 'state', message: 'State is required' });
  } else if (!validateState(data.state)) {
    errors.push({ field: 'state', message: 'Invalid US state abbreviation' });
  }

  if (!data.zipCode) {
    errors.push({ field: 'zipCode', message: 'ZIP code is required' });
  } else if (!validateZipCode(data.zipCode)) {
    errors.push({ field: 'zipCode', message: 'Invalid ZIP code format' });
  }

  return errors;
}

// ============================================================
// Class-validator based DTO (the new way - not fully adopted yet)
// ============================================================

// This was the plan: use DTOs with decorators and class-validator
// but we only got partway through the migration

export class CreatePatientDto {
  @IsNotEmpty({ message: 'First name is required' })
  @Length(1, 100)
  firstName!: string;

  @IsOptional()
  @Length(0, 100)
  middleName?: string;

  @IsNotEmpty({ message: 'Last name is required' })
  @Length(1, 100)
  lastName!: string;

  @IsNotEmpty({ message: 'Date of birth is required' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date of birth must be YYYY-MM-DD' })
  dateOfBirth!: string;

  @IsNotEmpty({ message: 'Gender is required' })
  gender!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^(?!000|666|9\d{2})\d{3}-?(?!00)\d{2}-?(?!0000)\d{4}$/, { message: 'Invalid SSN format' })
  ssn?: string;

  // ... rest of the fields never got added
}

// This function was going to replace validatePatientInput but we never finished
export async function validateWithDto(data: any): Promise<ValidationError[]> {
  const dto = Object.assign(new CreatePatientDto(), data);
  const classValidatorErrors = await validate(dto);

  return classValidatorErrors.map(err => ({
    field: err.property,
    message: Object.values(err.constraints || {}).join(', '),
    value: err.value,
  }));
}
