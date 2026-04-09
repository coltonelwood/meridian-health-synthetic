import { validatePatient, validateNPI, ValidationError } from '../src/utils/dataValidator';

// NOTE: we don't test the actual migration (insertBatch) because that needs
// a real database connection. There's a docker-compose.test.yml somewhere
// that sets up a test DB but it's flaky on CI.

describe('Patient Validation', () => {
  const validPatient = {
    first_name: 'John',
    last_name: 'Doe',
    date_of_birth: '1985-03-15',
    ssn: '123456789',
    gender: 'male',
    phone: '5551234567',
    email: 'john.doe@email.com',
    state: 'CA',
    zip_code: '90210',
    status: 'active',
  };

  it('should accept a valid patient record', () => {
    expect(() => validatePatient(validPatient)).not.toThrow();
  });

  it('should reject missing first name', () => {
    const patient = { ...validPatient, first_name: '' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject missing last name', () => {
    const patient = { ...validPatient, last_name: '' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject missing date of birth', () => {
    const patient = { ...validPatient, date_of_birth: null };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject future date of birth', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const patient = { ...validPatient, date_of_birth: future.toISOString() };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject suspiciously old DOB (>130 years)', () => {
    const patient = { ...validPatient, date_of_birth: '1850-01-01' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject test data names', () => {
    const patient = { ...validPatient, first_name: 'TEST' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject invalid SSN format', () => {
    const patient = { ...validPatient, ssn: '12345' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should reject SSN starting with 000', () => {
    const patient = { ...validPatient, ssn: '000123456' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should accept null SSN', () => {
    const patient = { ...validPatient, ssn: null };
    expect(() => validatePatient(patient)).not.toThrow();
  });

  it('should reject invalid state code', () => {
    const patient = { ...validPatient, state: 'XX' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  it('should accept DC as valid state', () => {
    const patient = { ...validPatient, state: 'DC' };
    expect(() => validatePatient(patient)).not.toThrow();
  });

  it('should reject invalid ZIP code', () => {
    const patient = { ...validPatient, zip_code: '123' };
    expect(() => validatePatient(patient)).toThrow(ValidationError);
  });

  // TODO: add tests for:
  // - phone number validation edge cases
  // - email validation edge cases
  // - SSN 666 prefix rejection
  // - name length limits
  // - unicode characters in names (accents, etc)
});

describe('NPI Validation', () => {
  it('should accept a valid NPI', () => {
    // 1234567893 is a valid NPI (passes Luhn check with 80840 prefix)
    expect(validateNPI('1234567893')).toBe(true);
  });

  it('should reject NPI that is too short', () => {
    expect(validateNPI('12345')).toBe(false);
  });

  it('should reject NPI that is too long', () => {
    expect(validateNPI('12345678901')).toBe(false);
  });

  it('should reject empty NPI', () => {
    expect(validateNPI('')).toBe(false);
  });

  it('should reject null NPI', () => {
    expect(validateNPI(null as any)).toBe(false);
  });

  // TODO: add more NPI test cases with known valid/invalid numbers
  // the Luhn check is tricky to test because you need to pre-compute
  // valid check digits
});
