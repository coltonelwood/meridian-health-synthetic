/**
 * Tests for the claim processor service.
 *
 * NOTE: These tests use mocked DB and Redis connections. Integration tests
 * that hit real databases are in tests/integration/ (not included in CI
 * because they're flaky - see CLAIMS-812).
 *
 * KNOWN ISSUE: Several tests use hardcoded dates that will break when
 * timely filing validation is affected. We should use relative dates
 * but nobody has fixed these yet.
 */

import { validateClaimForSubmission } from '../src/services/claimProcessor';
import { ClaimType, ClaimStatus, FilingIndicator, Claim } from '../src/models/Claim';
import { ClaimLine } from '../src/models/ClaimLine';
import { createTestClaim, createTestClaimLines } from './fixtures/sample-837';

// ---- validateClaimForSubmission tests ----

describe('validateClaimForSubmission', () => {
  let baseClaim: Claim;
  let baseLines: ClaimLine[];

  beforeEach(() => {
    baseClaim = createTestClaim() as Claim;
    baseLines = createTestClaimLines() as ClaimLine[];
  });

  describe('basic validation', () => {
    test('should pass validation for a valid simple claim', () => {
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toHaveLength(0);
    });

    test('should require subscriber ID', () => {
      baseClaim.subscriberId = '';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('Subscriber ID is required');
    });

    test('should require patient ID', () => {
      baseClaim.patient.patientId = '';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('Patient ID is required');
    });

    test('should require billing provider NPI', () => {
      baseClaim.provider.billingProviderNpi = '';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('Billing provider NPI is required');
    });

    test('should require payer ID', () => {
      baseClaim.payer.payerId = '';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('Payer ID is required');
    });

    test('should require at least one diagnosis code', () => {
      baseClaim.diagnosisCodes = [];
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('At least one diagnosis code is required');
    });

    test('should require service date', () => {
      baseClaim.serviceDateFrom = undefined;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('Service date is required');
    });

    test('should require at least one line item', () => {
      const errors = validateClaimForSubmission(baseClaim, []);
      expect(errors).toContain('Claim must have at least one line item');
    });
  });

  describe('NPI validation', () => {
    test('should reject invalid billing NPI (wrong length)', () => {
      baseClaim.provider.billingProviderNpi = '12345';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Billing provider NPI is invalid'))).toBe(true);
    });

    test('should reject invalid billing NPI (non-numeric)', () => {
      baseClaim.provider.billingProviderNpi = 'ABCDEFGHIJ';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Billing provider NPI is invalid'))).toBe(true);
    });

    // This NPI passes Luhn check
    test('should accept valid NPI format', () => {
      baseClaim.provider.billingProviderNpi = '1234567893';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('NPI is invalid'))).toBe(false);
    });
  });

  describe('diagnosis code validation', () => {
    test('should accept valid ICD-10 codes', () => {
      baseClaim.diagnosisCodes = ['J06.9', 'E11.65', 'M54.5'];
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.filter((e) => e.includes('Invalid ICD-10'))).toHaveLength(0);
    });

    test('should reject invalid ICD-10 code format', () => {
      baseClaim.diagnosisCodes = ['INVALID'];
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Invalid ICD-10 code: INVALID'))).toBe(true);
    });

    test('should reject ICD-10 codes starting with numbers', () => {
      baseClaim.diagnosisCodes = ['123.45'];
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Invalid ICD-10'))).toBe(true);
    });
  });

  describe('line item validation', () => {
    test('should reject invalid CPT code format', () => {
      baseLines[0].cptCode = 'ABC';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Invalid CPT code format'))).toBe(true);
    });

    test('should reject zero charge amount', () => {
      baseLines[0].chargeAmount = 0;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Charge amount must be positive'))).toBe(true);
    });

    test('should reject negative charge amount', () => {
      baseLines[0].chargeAmount = -50;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Charge amount must be positive'))).toBe(true);
    });

    test('should reject zero units', () => {
      baseLines[0].units = 0;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Units must be positive'))).toBe(true);
    });

    test('should reject invalid diagnosis pointer', () => {
      baseClaim.diagnosisCodes = ['J06.9'];
      baseLines[0].diagnosisPointer = [1, 3]; // 3 is invalid - only 1 DX
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('references non-existent diagnosis code'))).toBe(true);
    });
  });

  describe('service date validation', () => {
    test('should reject future service dates', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      baseClaim.serviceDateFrom = futureDate.toISOString().slice(0, 10);
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Service date cannot be in the future'))).toBe(true);
    });

    // FIXME: This test will break after 2025-01-15 because the hardcoded
    // date will exceed the 365-day timely filing limit. Use a relative
    // date instead.
    test('should warn about timely filing for old dates', () => {
      baseClaim.serviceDateFrom = '2022-01-01';
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('timely filing'))).toBe(true);
    });
  });

  describe('institutional claim validation', () => {
    test('should require admission date for institutional claims', () => {
      baseClaim.claimType = ClaimType.INSTITUTIONAL;
      baseClaim.admissionDate = undefined;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors).toContain('Admission date is required for institutional claims');
    });

    test('should require revenue codes on institutional claim lines', () => {
      baseClaim.claimType = ClaimType.INSTITUTIONAL;
      baseClaim.admissionDate = '2024-01-15';
      baseLines[0].revenueCode = undefined;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Revenue code is required'))).toBe(true);
    });
  });

  describe('payer-specific validation', () => {
    test('should require referring provider for Aetna', () => {
      baseClaim.payer.payerId = '60054';
      baseClaim.provider.renderingProviderNpi = '9876543210';
      baseClaim.provider.referringProviderNpi = undefined;
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('referring provider NPI'))).toBe(true);
    });

    test('should check max lines per claim for payer', () => {
      baseClaim.payer.payerId = '77027'; // FL Medicaid, max 25 lines
      const manyLines: ClaimLine[] = [];
      for (let i = 0; i < 26; i++) {
        manyLines.push({
          ...baseLines[0],
          id: `line-${i}`,
          lineNumber: i + 1,
        });
      }
      const errors = validateClaimForSubmission(baseClaim, manyLines);
      expect(errors.some((e) => e.includes('maximum of 25 lines'))).toBe(true);
    });

    test('should require prior auth for Medicaid surgical procedures', () => {
      baseClaim.payer.payerId = '77027'; // FL Medicaid
      baseClaim.payer.priorAuthNumber = undefined;
      baseLines[0].cptCode = '27447'; // Total knee - surgical
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      expect(errors.some((e) => e.includes('Prior authorization required'))).toBe(true);
    });

    test('should not require prior auth for non-surgical on Medicaid', () => {
      baseClaim.payer.payerId = '77027';
      baseClaim.payer.priorAuthNumber = undefined;
      baseLines[0].cptCode = '99213'; // Office visit - not surgical
      // We need to also set a valid NPI for this test
      baseClaim.provider.billingProviderNpi = '1234567893';
      baseClaim.provider.referringProviderNpi = '1234567893';
      baseClaim.serviceDateFrom = new Date().toISOString().slice(0, 10);
      const errors = validateClaimForSubmission(baseClaim, baseLines);
      // Should not have prior auth error for non-surgical
      expect(errors.some((e) => e.includes('Prior authorization required for 99213'))).toBe(false);
    });
  });

  describe('multi-line claims', () => {
    test('should validate multiple lines independently', () => {
      const multiLines = createTestClaimLines('test-claim-001', [
        { cptCode: '99214', chargeAmount: 225.00, modifier1: '25' },
        { cptCode: '20610', chargeAmount: 250.00 },
      ]) as ClaimLine[];

      baseClaim.diagnosisCodes = ['M54.5', 'M54.16'];
      baseClaim.totalChargeAmount = 475.00;

      const errors = validateClaimForSubmission(baseClaim, multiLines);
      expect(errors).toHaveLength(0);
    });

    test('should catch errors on specific lines', () => {
      const multiLines = createTestClaimLines('test-claim-001', [
        { cptCode: '99214', chargeAmount: 225.00 },
        { cptCode: 'INVALID', chargeAmount: -50, units: 0 },
      ]) as ClaimLine[];

      const errors = validateClaimForSubmission(baseClaim, multiLines);
      expect(errors.some((e) => e.includes('Line 2: Invalid CPT code'))).toBe(true);
      expect(errors.some((e) => e.includes('Line 2: Charge amount'))).toBe(true);
      expect(errors.some((e) => e.includes('Line 2: Units must be positive'))).toBe(true);
    });
  });
});
