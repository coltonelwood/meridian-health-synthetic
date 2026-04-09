/**
 * Tests for the adjudication engine.
 *
 * These test the core adjudication logic - fee schedule lookups,
 * patient responsibility calculations, denial detection, etc.
 *
 * The adjudication engine is mocked at the DB/Redis level. We test
 * the pure logic functions and mock the data access.
 */

import { ClaimType, ClaimStatus, FilingIndicator, Claim } from '../src/models/Claim';
import { ClaimLine } from '../src/models/ClaimLine';
import { createTestClaim, createTestClaimLines } from './fixtures/sample-837';

// We need to mock the DB and Redis for runAdjudication
const mockPool = {
  query: jest.fn(),
  connect: jest.fn().mockResolvedValue({
    query: jest.fn(),
    release: jest.fn(),
  }),
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn(),
  setex: jest.fn(),
  publish: jest.fn(),
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// Mock the pool.query for duplicate check (returns no duplicates by default)
mockPool.query.mockResolvedValue({ rows: [] });

import { runAdjudication, AdjudicationResult } from '../src/services/adjudicationEngine';

describe('adjudicationEngine', () => {
  let claim: Claim;
  let lines: ClaimLine[];

  beforeEach(() => {
    jest.clearAllMocks();
    claim = createTestClaim({ status: ClaimStatus.SUBMITTED }) as Claim;
    lines = createTestClaimLines() as ClaimLine[];
    // Reset mock to return no duplicates
    mockPool.query.mockResolvedValue({ rows: [] });
  });

  describe('simple office visit adjudication', () => {
    test('should adjudicate a simple 99213 office visit', async () => {
      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      expect(result.approved).toBe(true);
      expect(result.lineResults).toHaveLength(1);
      expect(result.lineResults[0].cptCode).toBe('99213');
      expect(result.lineResults[0].allowedAmount).toBeLessThanOrEqual(lines[0].chargeAmount);
      expect(result.totalPaidAmount).toBeGreaterThan(0);
    });

    test('should apply copay for office visits', async () => {
      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      // Default copay is $30
      expect(lineResult.copayAmount).toBe(30);
      expect(lineResult.coinsuranceAmount).toBe(0); // office visits don't have coinsurance
    });

    test('should calculate contractual adjustment', async () => {
      // Charge is $150, fee schedule for 99213 is $145
      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      // Adjustment = charge - allowed
      expect(lineResult.adjustmentAmount).toBe(
        lineResult.chargeAmount - lineResult.allowedAmount
      );
    });

    test('should include appropriate adjustment reason codes', async () => {
      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      // Should have CARC 45 (fee schedule reduction) and 3 (copay)
      expect(lineResult.adjustmentReasonCodes).toContain('3'); // copay
    });
  });

  describe('multi-line adjudication', () => {
    test('should adjudicate multiple lines independently', async () => {
      const multiLines = createTestClaimLines('test-claim-001', [
        { cptCode: '99214', chargeAmount: 225.00, modifier1: '25' },
        { cptCode: '20610', chargeAmount: 250.00 },
      ]) as ClaimLine[];

      claim.totalChargeAmount = 475.00;
      claim.diagnosisCodes = ['M54.5', 'M54.16'];

      const result = await runAdjudication(
        claim, multiLines, mockPool as any, mockRedis as any, mockLogger as any
      );

      expect(result.approved).toBe(true);
      expect(result.lineResults).toHaveLength(2);
      expect(result.totalPaidAmount).toBeGreaterThan(0);
      // Each line should have its own adjudication
      expect(result.lineResults[0].cptCode).toBe('99214');
      expect(result.lineResults[1].cptCode).toBe('20610');
    });

    test('should apply copay only on first E&M line', async () => {
      const multiLines = createTestClaimLines('test-claim-001', [
        { cptCode: '99214', chargeAmount: 225.00, modifier1: '25', lineNumber: 1 },
        { cptCode: '99213', chargeAmount: 150.00, lineNumber: 2 },
      ]) as ClaimLine[];

      claim.totalChargeAmount = 375.00;

      const result = await runAdjudication(
        claim, multiLines, mockPool as any, mockRedis as any, mockLogger as any
      );

      // Only first line should have copay
      expect(result.lineResults[0].copayAmount).toBe(30);
      expect(result.lineResults[1].copayAmount).toBe(0);
    });
  });

  describe('deductible application', () => {
    test('should apply remaining deductible', async () => {
      // Default remaining deductible is $500
      // For a surgical procedure (non-office-visit), deductible applies
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '29881', chargeAmount: 1500.00 },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 1500.00;

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      expect(lineResult.deductibleAmount).toBeGreaterThan(0);
      expect(lineResult.adjustmentReasonCodes).toContain('1'); // deductible CARC
    });

    test('should apply deductible across multiple lines', async () => {
      const multiLines = createTestClaimLines('test-claim-001', [
        { cptCode: '29881', chargeAmount: 1500.00, lineNumber: 1 },
        { cptCode: '72148', chargeAmount: 500.00, lineNumber: 2 },
      ]) as ClaimLine[];

      claim.totalChargeAmount = 2000.00;
      claim.diagnosisCodes = ['M23.51'];

      const result = await runAdjudication(
        claim, multiLines, mockPool as any, mockRedis as any, mockLogger as any
      );

      // Total deductible should not exceed $500 (default remaining)
      const totalDeductible = result.lineResults.reduce(
        (sum, lr) => sum + lr.deductibleAmount, 0
      );
      expect(totalDeductible).toBeLessThanOrEqual(500);
    });
  });

  describe('preventive services', () => {
    test('should not apply cost sharing to preventive visits (ACA)', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '99395', chargeAmount: 250.00 },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 250.00;

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      expect(lineResult.copayAmount).toBe(0);
      expect(lineResult.coinsuranceAmount).toBe(0);
      expect(lineResult.deductibleAmount).toBe(0);
    });
  });

  describe('ER visit adjudication', () => {
    test('should apply ER copay for ED visits', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '99284', chargeAmount: 500.00 },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 500.00;
      claim.provider.placeOfService = '23'; // ER

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      // Default ER copay is $250
      expect(lineResult.copayAmount).toBe(250);
    });
  });

  describe('behavioral health adjudication', () => {
    test('should apply specialist copay for behavioral health', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '90834', chargeAmount: 200.00 },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 200.00;
      claim.diagnosisCodes = ['F32.1'];

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      // Default specialist copay is $50
      expect(lineResult.copayAmount).toBe(50);
    });

    test('should deny Medicare behavioral health without F-code diagnosis', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '90834', chargeAmount: 200.00 },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 200.00;
      claim.filingIndicator = FilingIndicator.MEDICARE_B;
      claim.diagnosisCodes = ['M54.5']; // Not an F-code

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      expect(result.approved).toBe(false);
      expect(result.denialReasonCode).toBe('50'); // medical necessity
    });
  });

  describe('duplicate claim detection', () => {
    test('should deny if duplicate claim found with overlapping CPT codes', async () => {
      // Mock: existing claim found
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'existing-claim-1', claim_number: 'CLM-OLD-001', status: 'ADJUDICATED' }] })
        .mockResolvedValueOnce({ rows: [{ cpt_code: '99213' }] }); // overlapping CPT

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      expect(result.approved).toBe(false);
      expect(result.denialReasonCode).toBe('18'); // duplicate claim
      expect(result.denialReasonDescription).toContain('duplicate');
    });

    test('should not deny if existing claims have different CPT codes', async () => {
      // Mock: existing claim found but different CPT codes
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'existing-claim-1', claim_number: 'CLM-OLD-001', status: 'ADJUDICATED' }] })
        .mockResolvedValueOnce({ rows: [{ cpt_code: '99215' }] }); // different CPT

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      // Should proceed with adjudication
      expect(result.approved).toBe(true);
    });
  });

  describe('modifier handling', () => {
    test('should reduce allowed amount for modifier 26 (professional component)', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '71046', chargeAmount: 100.00, modifier1: '26' },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 100.00;

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      // Modifier 26 reduces to 60% of allowed
      const lineResult = result.lineResults[0];
      // Fee schedule rate for 71046 is $35, * 0.60 = $21
      expect(lineResult.allowedAmount).toBeLessThanOrEqual(35 * 0.60 + 0.01);
    });

    test('should reduce allowed amount for modifier TC (technical component)', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '71046', chargeAmount: 100.00, modifier1: 'TC' },
      ]) as ClaimLine[];
      claim.totalChargeAmount = 100.00;

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      // Modifier TC reduces to 40% of allowed
      expect(lineResult.allowedAmount).toBeLessThanOrEqual(35 * 0.40 + 0.01);
    });
  });

  describe('fee schedule', () => {
    test('should use 65% heuristic for unknown CPT codes', async () => {
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '43239', chargeAmount: 1000.00 }, // Not in our fee schedule
      ]) as ClaimLine[];
      claim.totalChargeAmount = 1000.00;

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      expect(lineResult.allowedAmount).toBe(650.00); // 1000 * 0.65
    });

    test('should cap allowed amount at charge amount', async () => {
      // Charge is less than fee schedule rate
      lines = createTestClaimLines('test-claim-001', [
        { cptCode: '99213', chargeAmount: 50.00 }, // Fee schedule is $145
      ]) as ClaimLine[];
      claim.totalChargeAmount = 50.00;

      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      const lineResult = result.lineResults[0];
      expect(lineResult.allowedAmount).toBeLessThanOrEqual(50.00);
      expect(lineResult.adjustmentAmount).toBe(0); // no adjustment needed
    });
  });

  describe('rounding', () => {
    test('should round all amounts to 2 decimal places', async () => {
      const result = await runAdjudication(
        claim, lines, mockPool as any, mockRedis as any, mockLogger as any
      );

      expect(result.totalPaidAmount).toBe(Math.round(result.totalPaidAmount * 100) / 100);
      expect(result.patientResponsibility).toBe(Math.round(result.patientResponsibility * 100) / 100);

      for (const lr of result.lineResults) {
        expect(lr.allowedAmount).toBe(Math.round(lr.allowedAmount * 100) / 100);
        expect(lr.paidAmount).toBe(Math.round(lr.paidAmount * 100) / 100);
        expect(lr.copayAmount).toBe(Math.round(lr.copayAmount * 100) / 100);
      }
    });
  });

  // FIXME: This test uses a hardcoded date. It works now but will fail
  // if the fee schedule rates change or if the test data is modified.
  test('specific adjudication amounts for known fixture data', async () => {
    // Using the exact fixture data: 99213, $150 charge, BCBS FL
    const result = await runAdjudication(
      claim, lines, mockPool as any, mockRedis as any, mockLogger as any
    );

    // Expected: fee schedule $145, copay $30, no deductible (office visit)
    // Paid = 145 - 30 = $115
    expect(result.lineResults[0].allowedAmount).toBe(145.00);
    expect(result.lineResults[0].copayAmount).toBe(30.00);
    expect(result.lineResults[0].paidAmount).toBe(115.00);
    expect(result.lineResults[0].adjustmentAmount).toBe(5.00); // 150 - 145
    expect(result.totalPaidAmount).toBe(115.00);
    expect(result.patientResponsibility).toBe(30.00);
  });
});
