/**
 * Automated Adjudication Rules Engine
 *
 * Determines how much a payer should pay for each claim line based on:
 * - Fee schedules (contracted rates)
 * - Patient benefits (copay, coinsurance, deductible)
 * - Bundling/unbundling rules (CCI edits)
 * - Medical necessity (very basic)
 *
 * KNOWN ISSUES:
 * - Fee schedules are hardcoded (should come from payer contracts DB)
 * - Deductible tracking is per-claim, not per-patient-per-year
 * - CCI edits are not fully implemented
 * - No support for COB (coordination of benefits)
 * - Doesn't check for duplicate claims properly
 *
 * Despite all this, it auto-adjudicates about 70% of commercial claims
 * correctly (validated against manual adjudication results quarterly).
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import winston from 'winston';
import { Claim, ClaimType, FilingIndicator } from '../models/Claim';
import { ClaimLine, getModifiers } from '../models/ClaimLine';
import { lookupCptCode } from '../utils/cptLookup';
import { getPayerConfig } from '../utils/payerRules';

export interface LineAdjudicationResult {
  lineId: string;
  lineNumber: number;
  cptCode: string;
  status: 'APPROVED' | 'DENIED' | 'ADJUSTED';
  chargeAmount: number;
  allowedAmount: number;
  paidAmount: number;
  adjustmentAmount: number;
  copayAmount: number;
  coinsuranceAmount: number;
  deductibleAmount: number;
  remarkCodes: string[];
  adjustmentReasonCodes: string[];
  denialReason?: string;
}

export interface AdjudicationResult {
  approved: boolean;
  totalChargeAmount: number;
  totalAllowedAmount: number;
  totalPaidAmount: number;
  patientResponsibility: number;
  denialReasonCode?: string;
  denialReasonDescription?: string;
  lineResults: LineAdjudicationResult[];
  details: Record<string, any>;
}

// Hardcoded fee schedules. In reality, these are negotiated per-payer-per-provider
// and stored in a contracts database. This is just for auto-adjudication.
// The rates are loosely based on 2024 Medicare MPFS (Medicare Physician Fee Schedule)
// multiplied by a commercial markup factor.
//
// THIS IS NOT REAL PRICING DATA. If you're using this to actually price claims,
// please stop and talk to someone in the contracts team.
const FEE_SCHEDULE: Record<string, number> = {
  // E&M Office
  '99202': 110.00,
  '99203': 175.00,
  '99204': 260.00,
  '99205': 345.00,
  '99211': 35.00,
  '99212': 85.00,
  '99213': 145.00,
  '99214': 205.00,
  '99215': 295.00,
  // E&M Hospital
  '99221': 210.00,
  '99222': 280.00,
  '99223': 395.00,
  '99231': 85.00,
  '99232': 150.00,
  '99233': 215.00,
  // ED
  '99281': 75.00,
  '99282': 130.00,
  '99283': 195.00,
  '99284': 320.00,
  '99285': 465.00,
  // Behavioral health
  '90791': 310.00,
  '90792': 365.00,
  '90832': 95.00,
  '90834': 135.00,
  '90837': 185.00,
  '90847': 165.00,
  // Surgery
  '10060': 250.00,
  '20610': 165.00,
  '27447': 2850.00,
  '27130': 2750.00,
  '29881': 1100.00,
  // Immunization
  '90460': 25.00,
  '90471': 25.00,
  '90472': 20.00,
  // Labs
  '80053': 22.00,
  '85025': 11.00,
  '87086': 12.00,
  '81001': 5.00,
  // Radiology
  '71046': 35.00,
  '73030': 32.00,
  '72148': 375.00,
  // Preventive
  '99385': 225.00,
  '99386': 260.00,
  '99395': 195.00,
  '99396': 220.00,
};

// Default patient benefit parameters (when we can't look up actual benefits)
// These are roughly average commercial plan values
const DEFAULT_BENEFITS = {
  copay: 30,           // $30 copay for office visits
  specialistCopay: 50, // $50 copay for specialist visits
  erCopay: 250,        // $250 ER copay
  coinsuranceRate: 0.20, // 20% coinsurance after deductible
  deductibleRemaining: 500, // assume $500 remaining deductible
  outOfPocketMax: 8000, // $8000 OOP max
  outOfPocketSpent: 0,  // assume nothing spent (this is wrong most of the time)
};

/**
 * Run the adjudication engine on a claim.
 */
export async function runAdjudication(
  claim: Claim,
  lines: ClaimLine[],
  pool: Pool,
  redis: Redis,
  logger: winston.Logger
): Promise<AdjudicationResult> {
  const details: Record<string, any> = {
    engine: 'auto-adjudication-v2',
    processedAt: new Date().toISOString(),
    warnings: [] as string[],
  };

  // Try to get patient benefits from cache/DB
  // In reality this would call the eligibility/benefits service
  let benefits = { ...DEFAULT_BENEFITS };
  try {
    const cachedBenefits = await redis.get(`benefits:${claim.subscriberId}:${claim.payer.payerId}`);
    if (cachedBenefits) {
      benefits = { ...benefits, ...JSON.parse(cachedBenefits) };
      details.benefitsSource = 'cache';
    } else {
      details.benefitsSource = 'default';
      details.warnings.push('Using default benefits - actual patient benefits not available');
    }
  } catch {
    details.benefitsSource = 'default';
  }

  // Check for duplicate claims (very basic - just checks claim number pattern)
  // A real duplicate check would look at subscriber + provider + DOS + CPT codes
  const dupeCheck = await pool.query(
    `SELECT id, claim_number, status FROM claims
     WHERE subscriber_id = $1 AND billing_provider_npi = $2
     AND service_date_from = $3 AND status NOT IN ('VOID', 'DRAFT')
     AND id != $4 AND deleted_at IS NULL`,
    [claim.subscriberId, claim.provider.billingProviderNpi, claim.serviceDateFrom, claim.id]
  );

  if (dupeCheck.rows.length > 0) {
    // Check if any of the existing claims have overlapping CPT codes
    for (const existingClaim of dupeCheck.rows) {
      const existingLines = await pool.query(
        'SELECT cpt_code FROM claim_lines WHERE claim_id = $1',
        [existingClaim.id]
      );
      const existingCpts = new Set(existingLines.rows.map((r: any) => r.cpt_code));
      const currentCpts = new Set(lines.map((l) => l.cptCode));
      const overlap = [...currentCpts].filter((c) => existingCpts.has(c));

      if (overlap.length > 0) {
        return {
          approved: false,
          totalChargeAmount: claim.totalChargeAmount,
          totalAllowedAmount: 0,
          totalPaidAmount: 0,
          patientResponsibility: 0,
          denialReasonCode: '18',
          denialReasonDescription: `Possible duplicate claim. Existing claim ${existingClaim.claim_number} has overlapping CPT codes: ${overlap.join(', ')}`,
          lineResults: lines.map((l) => ({
            lineId: l.id,
            lineNumber: l.lineNumber,
            cptCode: l.cptCode,
            status: 'DENIED' as const,
            chargeAmount: l.chargeAmount,
            allowedAmount: 0,
            paidAmount: 0,
            adjustmentAmount: l.chargeAmount,
            copayAmount: 0,
            coinsuranceAmount: 0,
            deductibleAmount: 0,
            remarkCodes: [],
            adjustmentReasonCodes: ['18'],
            denialReason: 'Duplicate claim',
          })),
          details,
        };
      }
    }
  }

  // Process each line
  const lineResults: LineAdjudicationResult[] = [];
  let totalAllowed = 0;
  let totalPaid = 0;
  let totalPatientResp = 0;
  let remainingDeductible = benefits.deductibleRemaining;
  let allLinesDenied = true;

  for (const line of lines) {
    const lineResult = adjudicateLine(line, claim, benefits, remainingDeductible, details);
    lineResults.push(lineResult);

    if (lineResult.status !== 'DENIED') {
      allLinesDenied = false;
    }

    totalAllowed += lineResult.allowedAmount;
    totalPaid += lineResult.paidAmount;
    totalPatientResp += lineResult.copayAmount + lineResult.coinsuranceAmount + lineResult.deductibleAmount;

    // Reduce remaining deductible
    remainingDeductible = Math.max(0, remainingDeductible - lineResult.deductibleAmount);
  }

  // If all lines are denied, deny the whole claim
  if (allLinesDenied) {
    // Use the first line's denial reason
    const firstDeniedLine = lineResults[0];
    return {
      approved: false,
      totalChargeAmount: claim.totalChargeAmount,
      totalAllowedAmount: 0,
      totalPaidAmount: 0,
      patientResponsibility: 0,
      denialReasonCode: firstDeniedLine.adjustmentReasonCodes[0] || '96',
      denialReasonDescription: firstDeniedLine.denialReason || 'All service lines denied',
      lineResults,
      details,
    };
  }

  return {
    approved: true,
    totalChargeAmount: claim.totalChargeAmount,
    totalAllowedAmount: Math.round(totalAllowed * 100) / 100,
    totalPaidAmount: Math.round(totalPaid * 100) / 100,
    patientResponsibility: Math.round(totalPatientResp * 100) / 100,
    lineResults,
    details,
  };
}

/**
 * Adjudicate a single claim line.
 *
 * This is where the real "fun" happens. Different logic for:
 * - E&M codes
 * - Surgical procedures
 * - Lab/path
 * - Radiology
 * - Preventive services
 *
 * Each has different copay/coinsurance rules, modifier logic, etc.
 */
function adjudicateLine(
  line: ClaimLine,
  claim: Claim,
  benefits: typeof DEFAULT_BENEFITS,
  remainingDeductible: number,
  details: Record<string, any>
): LineAdjudicationResult {
  const cptInfo = lookupCptCode(line.cptCode);
  const modifiers = getModifiers(line);
  const chargeAmount = line.chargeAmount * line.units;

  // Step 1: Determine allowed amount from fee schedule
  let allowedAmount = FEE_SCHEDULE[line.cptCode];
  if (!allowedAmount) {
    // Code not in our fee schedule - use a rough heuristic
    // (charge amount * 0.65 is roughly what commercial payers pay)
    allowedAmount = chargeAmount * 0.65;
    if (!details.warnings) details.warnings = [];
    details.warnings.push(`No fee schedule rate for ${line.cptCode}, using 65% of charges`);
  }

  // Apply units
  allowedAmount = allowedAmount * line.units;

  // Cap allowed amount at charge amount (can't pay more than charged)
  allowedAmount = Math.min(allowedAmount, chargeAmount);

  // Step 2: Check for line-level denials
  // Check medical necessity (very basic - just checks if DX supports CPT)
  // In reality this would check LCD/NCD policies
  if (claim.filingIndicator === FilingIndicator.MEDICARE_B) {
    // Medicare has strict medical necessity requirements
    // We don't really check them properly but we flag some obvious ones
    const cptNumeric = parseInt(line.cptCode, 10);
    if (cptNumeric >= 90791 && cptNumeric <= 90899) {
      // Behavioral health - needs F-code diagnosis
      const hasBehavioralDx = claim.diagnosisCodes.some((dx) => dx.startsWith('F'));
      if (!hasBehavioralDx) {
        return createDeniedLine(line, chargeAmount, '50',
          'Medical necessity: behavioral health service requires mental health diagnosis (F-code)');
      }
    }
  }

  // Check modifier logic
  if (modifiers.includes('59') || modifiers.includes('XE') || modifiers.includes('XS')
      || modifiers.includes('XP') || modifiers.includes('XU')) {
    // Distinct procedure modifier - reduce allowed by 50% for the additional procedure
    // This is a simplification - real logic depends on the specific CCI edit pair
    // But it's close enough for auto-adjudication
    if (line.lineNumber > 1) {
      // Only reduce for non-first lines with modifier 59
      allowedAmount = allowedAmount;  // Actually don't reduce - we decided not to
      // LOL at this code. The PM changed their mind three times on this.
      // First it was 50%, then 75%, then "just leave it."  - Derek 2024-06
    }
  }

  // Modifier 26 (Professional component) - reduce allowed by ~40%
  if (modifiers.includes('26')) {
    allowedAmount = allowedAmount * 0.60;
  }

  // Modifier TC (Technical component) - reduce allowed by ~60%
  if (modifiers.includes('TC')) {
    allowedAmount = allowedAmount * 0.40;
  }

  // Step 3: Calculate patient responsibility
  let copay = 0;
  let coinsurance = 0;
  let deductible = 0;

  const cptNumeric = parseInt(line.cptCode, 10);

  // Preventive services - no cost sharing (ACA requirement)
  const isPreventive = (cptNumeric >= 99381 && cptNumeric <= 99397) ||
                       (cptNumeric >= 99460 && cptNumeric <= 99463);

  if (isPreventive && claim.filingIndicator !== FilingIndicator.MEDICAID) {
    // No copay, no coinsurance, no deductible for preventive services
    copay = 0;
    coinsurance = 0;
    deductible = 0;
  } else {
    // Apply deductible first
    if (remainingDeductible > 0) {
      deductible = Math.min(remainingDeductible, allowedAmount);
    }

    const afterDeductible = allowedAmount - deductible;

    // Determine copay based on service type
    if (cptNumeric >= 99281 && cptNumeric <= 99285) {
      // ER visit
      copay = benefits.erCopay;
      coinsurance = 0; // ER usually copay only, no coinsurance
    } else if (cptNumeric >= 99201 && cptNumeric <= 99215) {
      // Office visit - copay covers it
      copay = line.lineNumber === 1 ? benefits.copay : 0; // only one copay per visit
      coinsurance = 0;
    } else if (cptNumeric >= 90791 && cptNumeric <= 90899) {
      // Behavioral health - specialist copay
      copay = line.lineNumber === 1 ? benefits.specialistCopay : 0;
      coinsurance = 0;
    } else {
      // Everything else gets coinsurance
      copay = 0;
      coinsurance = afterDeductible * benefits.coinsuranceRate;
    }

    // Cap copay at allowed amount
    copay = Math.min(copay, allowedAmount);
  }

  // Step 4: Calculate paid amount
  const adjustmentAmount = chargeAmount - allowedAmount; // contractual adjustment
  const paidAmount = allowedAmount - copay - coinsurance - deductible;

  // Build remark codes
  const remarkCodes: string[] = [];
  const adjustmentReasonCodes: string[] = [];

  if (adjustmentAmount > 0) {
    adjustmentReasonCodes.push('45'); // charge exceeds fee schedule
    remarkCodes.push('N362');
  }
  if (copay > 0) adjustmentReasonCodes.push('3');
  if (coinsurance > 0) adjustmentReasonCodes.push('2');
  if (deductible > 0) adjustmentReasonCodes.push('1');

  return {
    lineId: line.id,
    lineNumber: line.lineNumber,
    cptCode: line.cptCode,
    status: paidAmount > 0 ? 'APPROVED' : 'ADJUSTED',
    chargeAmount: Math.round(chargeAmount * 100) / 100,
    allowedAmount: Math.round(allowedAmount * 100) / 100,
    paidAmount: Math.round(Math.max(0, paidAmount) * 100) / 100,
    adjustmentAmount: Math.round(adjustmentAmount * 100) / 100,
    copayAmount: Math.round(copay * 100) / 100,
    coinsuranceAmount: Math.round(coinsurance * 100) / 100,
    deductibleAmount: Math.round(deductible * 100) / 100,
    remarkCodes,
    adjustmentReasonCodes,
  };
}

function createDeniedLine(
  line: ClaimLine,
  chargeAmount: number,
  reasonCode: string,
  reason: string
): LineAdjudicationResult {
  return {
    lineId: line.id,
    lineNumber: line.lineNumber,
    cptCode: line.cptCode,
    status: 'DENIED',
    chargeAmount,
    allowedAmount: 0,
    paidAmount: 0,
    adjustmentAmount: chargeAmount,
    copayAmount: 0,
    coinsuranceAmount: 0,
    deductibleAmount: 0,
    remarkCodes: [],
    adjustmentReasonCodes: [reasonCode],
    denialReason: reason,
  };
}
