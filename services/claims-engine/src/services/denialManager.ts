/**
 * Denial Management Service
 *
 * Handles claim denials and the appeal process. Denial management is one
 * of the most important (and annoying) parts of revenue cycle management.
 *
 * When a claim is denied, we need to:
 * 1. Categorize the denial (is it correctable? appealable?)
 * 2. Determine the appeal deadline
 * 3. For auto-appealable denials, generate and submit the appeal
 * 4. Track appeal status and outcomes
 *
 * About 15-20% of initial claims get denied. Of those, we successfully
 * appeal about 60% when we actually follow up (which is the hard part).
 * This service tries to automate as much of the follow-up as possible.
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import winston from 'winston';
import { Claim, ClaimStatus, claimFromRow } from '../models/Claim';
import { ClaimLine, claimLineFromRow } from '../models/ClaimLine';
import { getPayerConfig } from '../utils/payerRules';

export interface DenialAnalysis {
  claimId: string;
  claimNumber: string;
  denialCode: string;
  denialDescription: string;
  category: DenialCategory;
  isAppealable: boolean;
  isAutoAppealEligible: boolean;
  appealDeadline?: Date;
  suggestedAction: string;
  suggestedCorrectionSteps?: string[];
  estimatedRecoveryAmount?: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

export enum DenialCategory {
  ELIGIBILITY = 'ELIGIBILITY',           // patient not eligible
  AUTHORIZATION = 'AUTHORIZATION',       // missing prior auth
  CODING = 'CODING',                     // coding errors (modifier, DX, CPT)
  DUPLICATE = 'DUPLICATE',               // duplicate claim
  TIMELY_FILING = 'TIMELY_FILING',       // filed too late
  MEDICAL_NECESSITY = 'MEDICAL_NECESSITY', // not medically necessary
  BUNDLING = 'BUNDLING',                 // unbundling issue
  COORDINATION = 'COORDINATION',         // COB issues
  INFORMATION = 'INFORMATION',           // missing information
  NON_COVERED = 'NON_COVERED',           // service not covered
  OTHER = 'OTHER',
}

// Map CARC codes to denial categories
// This is a simplified mapping - many codes can fall into multiple categories
const CARC_CATEGORY_MAP: Record<string, DenialCategory> = {
  '1': DenialCategory.OTHER,            // deductible
  '2': DenialCategory.OTHER,            // coinsurance
  '3': DenialCategory.OTHER,            // copay
  '4': DenialCategory.CODING,           // procedure/modifier inconsistency
  '5': DenialCategory.CODING,           // procedure/POS inconsistency
  '16': DenialCategory.INFORMATION,     // missing info
  '18': DenialCategory.DUPLICATE,       // duplicate claim
  '22': DenialCategory.COORDINATION,    // COB
  '23': DenialCategory.COORDINATION,    // prior payer adjudication
  '27': DenialCategory.ELIGIBILITY,     // coverage terminated
  '29': DenialCategory.TIMELY_FILING,   // filing limit expired
  '45': DenialCategory.OTHER,           // charge exceeds fee schedule (not really a denial)
  '50': DenialCategory.MEDICAL_NECESSITY, // not medically necessary
  '96': DenialCategory.NON_COVERED,     // non-covered charges
  '97': DenialCategory.BUNDLING,        // bundled service
  '109': DenialCategory.NON_COVERED,    // not covered by this payer
  '197': DenialCategory.AUTHORIZATION,  // missing prior auth
  '204': DenialCategory.NON_COVERED,    // not covered under benefit plan
  '242': DenialCategory.OTHER,          // non-network provider
};

/**
 * Analyze a denied claim and determine next steps.
 */
export async function analyzeDenial(
  claimId: string,
  pool: Pool,
  logger: winston.Logger
): Promise<DenialAnalysis> {
  const [claimResult, linesResult] = await Promise.all([
    pool.query('SELECT * FROM claims WHERE id = $1', [claimId]),
    pool.query('SELECT * FROM claim_lines WHERE claim_id = $1 ORDER BY line_number', [claimId]),
  ]);

  if (claimResult.rows.length === 0) {
    throw new Error(`Claim ${claimId} not found`);
  }

  const claim = claimFromRow(claimResult.rows[0]);
  const lines = linesResult.rows.map(claimLineFromRow);

  if (claim.status !== ClaimStatus.DENIED) {
    throw new Error(`Claim ${claimId} is not in DENIED status`);
  }

  const denialCode = claim.denial?.reasonCode || 'UNKNOWN';
  const category = CARC_CATEGORY_MAP[denialCode] || DenialCategory.OTHER;

  // Check if this denial code is auto-appeal eligible
  const autoAppealResult = await pool.query(
    'SELECT auto_appeal_eligible FROM adjustment_reason_codes WHERE code = $1',
    [denialCode]
  );
  const isAutoAppealEligible = autoAppealResult.rows[0]?.auto_appeal_eligible || false;

  // Determine priority based on charge amount and category
  let priority: 'HIGH' | 'MEDIUM' | 'LOW';
  if (claim.totalChargeAmount > 5000 || category === DenialCategory.AUTHORIZATION) {
    priority = 'HIGH';
  } else if (claim.totalChargeAmount > 1000 || category === DenialCategory.CODING) {
    priority = 'MEDIUM';
  } else {
    priority = 'LOW';
  }

  // Generate suggested action and correction steps
  const { suggestedAction, correctionSteps } = getSuggestedAction(category, denialCode, claim, lines);

  // Check if we're still within the appeal deadline
  const isAppealable = claim.denial?.appealDeadline
    ? new Date(claim.denial.appealDeadline) > new Date()
    : true; // if no deadline set, assume it's still appealable

  // Estimate recovery amount based on historical success rates for this denial code
  // These rates are completely made up but in a real system we'd track actual outcomes
  const recoveryRates: Record<string, number> = {
    [DenialCategory.CODING]: 0.75,
    [DenialCategory.INFORMATION]: 0.85,
    [DenialCategory.AUTHORIZATION]: 0.50,
    [DenialCategory.MEDICAL_NECESSITY]: 0.40,
    [DenialCategory.DUPLICATE]: 0.20,
    [DenialCategory.TIMELY_FILING]: 0.10,
    [DenialCategory.ELIGIBILITY]: 0.15,
    [DenialCategory.BUNDLING]: 0.60,
    [DenialCategory.COORDINATION]: 0.45,
    [DenialCategory.NON_COVERED]: 0.25,
    [DenialCategory.OTHER]: 0.30,
  };

  const recoveryRate = recoveryRates[category] || 0.30;
  const estimatedRecovery = claim.totalChargeAmount * recoveryRate;

  return {
    claimId: claim.id,
    claimNumber: claim.claimNumber,
    denialCode,
    denialDescription: claim.denial?.reasonDescription || 'Unknown denial reason',
    category,
    isAppealable,
    isAutoAppealEligible,
    appealDeadline: claim.denial?.appealDeadline,
    suggestedAction,
    suggestedCorrectionSteps: correctionSteps,
    estimatedRecoveryAmount: Math.round(estimatedRecovery * 100) / 100,
    priority,
  };
}

/**
 * Submit an appeal for a denied claim.
 */
export async function submitAppeal(
  claimId: string,
  appealReason: string,
  supportingDocs: string[],
  userId: string,
  pool: Pool,
  redis: Redis,
  logger: winston.Logger
): Promise<{ success: boolean; message: string }> {
  const claimResult = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
  if (claimResult.rows.length === 0) {
    throw new Error(`Claim ${claimId} not found`);
  }

  const claim = claimFromRow(claimResult.rows[0]);

  if (claim.status !== ClaimStatus.DENIED) {
    return { success: false, message: `Claim is in ${claim.status} status, not DENIED` };
  }

  // Check appeal deadline
  if (claim.denial?.appealDeadline && new Date(claim.denial.appealDeadline) < new Date()) {
    return { success: false, message: 'Appeal deadline has passed' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update claim status to APPEALED
    await client.query(
      `UPDATE claims SET
        status = 'APPEALED',
        updated_by = $1,
        version = version + 1,
        metadata = metadata || $2
      WHERE id = $3`,
      [
        userId,
        JSON.stringify({
          appeal: {
            submittedAt: new Date().toISOString(),
            submittedBy: userId,
            reason: appealReason,
            supportingDocuments: supportingDocs,
          },
        }),
        claimId,
      ]
    );

    // Record status change
    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason, metadata)
       VALUES ($1, 'DENIED', 'APPEALED', $2, $3, $4)`,
      [
        claimId,
        userId,
        `Appeal submitted: ${appealReason}`,
        JSON.stringify({ supportingDocs }),
      ]
    );

    await client.query('COMMIT');

    // Publish appeal event for notification service
    try {
      await redis.publish('claim:appeal:submitted', JSON.stringify({
        claimId,
        claimNumber: claim.claimNumber,
        payerId: claim.payer.payerId,
        chargeAmount: claim.totalChargeAmount,
        appealReason,
        submittedBy: userId,
      }));
    } catch {
      // Non-critical
    }

    logger.info('Appeal submitted', { claimId, claimNumber: claim.claimNumber, userId });

    return { success: true, message: 'Appeal submitted successfully' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process auto-appealable denied claims.
 * This runs as a scheduled job to find and appeal denials that
 * we know can be corrected without manual intervention.
 */
export async function processAutoAppeals(
  pool: Pool,
  redis: Redis,
  logger: winston.Logger
): Promise<{ processed: number; appealed: number; skipped: number }> {
  // Find denied claims with auto-appealable denial codes
  const result = await pool.query(`
    SELECT c.*
    FROM claims c
    JOIN adjustment_reason_codes arc ON c.denial_reason_code = arc.code
    WHERE c.status = 'DENIED'
      AND arc.auto_appeal_eligible = TRUE
      AND c.deleted_at IS NULL
      AND (c.appeal_deadline IS NULL OR c.appeal_deadline > NOW())
      AND c.created_at > NOW() - INTERVAL '90 days'
    ORDER BY c.total_charge_amount DESC
    LIMIT 50
  `);

  let processed = 0;
  let appealed = 0;
  let skipped = 0;

  for (const row of result.rows) {
    const claim = claimFromRow(row);
    processed++;

    try {
      // Check if we've already attempted an auto-appeal
      if (claim.metadata?.autoAppealAttempted) {
        skipped++;
        continue;
      }

      const analysis = await analyzeDenial(claim.id, pool, logger);

      if (analysis.isAutoAppealEligible && analysis.isAppealable) {
        const appealResult = await submitAppeal(
          claim.id,
          `Auto-appeal: ${analysis.suggestedAction}. Original denial: ${analysis.denialCode} - ${analysis.denialDescription}`,
          [],
          'system:auto-appeal',
          pool,
          redis,
          logger
        );

        if (appealResult.success) {
          appealed++;

          // Mark that we auto-appealed so we don't do it again
          await pool.query(
            `UPDATE claims SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ autoAppealAttempted: true, autoAppealDate: new Date().toISOString() }), claim.id]
          );
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    } catch (err: any) {
      logger.error('Error processing auto-appeal', {
        claimId: claim.id,
        error: err.message,
      });
      skipped++;
    }
  }

  logger.info('Auto-appeal batch completed', { processed, appealed, skipped });
  return { processed, appealed, skipped };
}

/**
 * Get denial statistics for reporting.
 */
export async function getDenialStats(
  pool: Pool,
  payerId?: string,
  dateFrom?: string,
  dateTo?: string
): Promise<any> {
  const conditions = [`c.status = 'DENIED'`, `c.deleted_at IS NULL`];
  const params: any[] = [];
  let paramIdx = 1;

  if (payerId) {
    conditions.push(`c.payer_id = $${paramIdx++}`);
    params.push(payerId);
  }
  if (dateFrom) {
    conditions.push(`c.denial_date >= $${paramIdx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`c.denial_date <= $${paramIdx++}`);
    params.push(dateTo);
  }

  const whereClause = conditions.join(' AND ');

  const result = await pool.query(`
    SELECT
      c.denial_reason_code,
      arc.description as denial_description,
      arc.code_type,
      COUNT(*) as denial_count,
      SUM(c.total_charge_amount) as total_charges,
      AVG(c.total_charge_amount) as avg_charge,
      arc.auto_appeal_eligible
    FROM claims c
    LEFT JOIN adjustment_reason_codes arc ON c.denial_reason_code = arc.code
    WHERE ${whereClause}
    GROUP BY c.denial_reason_code, arc.description, arc.code_type, arc.auto_appeal_eligible
    ORDER BY denial_count DESC
  `, params);

  return {
    denialsByCode: result.rows.map((r: any) => ({
      code: r.denial_reason_code,
      description: r.denial_description || 'Unknown',
      count: parseInt(r.denial_count),
      totalCharges: parseFloat(r.total_charges),
      avgCharge: parseFloat(parseFloat(r.avg_charge).toFixed(2)),
      autoAppealEligible: r.auto_appeal_eligible,
    })),
    totalDenials: result.rows.reduce((sum: number, r: any) => sum + parseInt(r.denial_count), 0),
    totalDeniedCharges: result.rows.reduce((sum: number, r: any) => sum + parseFloat(r.total_charges), 0),
  };
}

// ---- Helper functions ----

function getSuggestedAction(
  category: DenialCategory,
  denialCode: string,
  claim: Claim,
  lines: ClaimLine[]
): { suggestedAction: string; correctionSteps: string[] } {
  switch (category) {
    case DenialCategory.CODING:
      return {
        suggestedAction: 'Review and correct coding, then resubmit',
        correctionSteps: [
          'Verify CPT codes match the documentation',
          'Check modifier usage (especially modifier 25 for E&M with procedures)',
          'Verify diagnosis codes support medical necessity for each CPT',
          'Check place of service is correct',
          'Resubmit as corrected claim (frequency code 7)',
        ],
      };

    case DenialCategory.AUTHORIZATION:
      return {
        suggestedAction: 'Obtain prior authorization and resubmit',
        correctionSteps: [
          'Check if prior auth was obtained but not included on the claim',
          'If auth exists, add auth number and resubmit',
          'If no auth, request retroactive authorization from payer',
          'Include clinical documentation supporting medical necessity',
          'Appeal with auth number once obtained',
        ],
      };

    case DenialCategory.INFORMATION:
      return {
        suggestedAction: 'Add missing information and resubmit',
        correctionSteps: [
          'Review the denial reason for specific missing data',
          'Contact the payer to identify exactly what information is needed',
          'Update the claim with the missing information',
          'Resubmit with corrected/complete data',
        ],
      };

    case DenialCategory.DUPLICATE:
      return {
        suggestedAction: 'Verify this is not a true duplicate before appealing',
        correctionSteps: [
          'Search for existing claims with same DOS, patient, and provider',
          'If truly a duplicate, void this claim',
          'If services are distinct, add appropriate modifiers (59, XE, XS, XP, XU)',
          'Resubmit with documentation showing services are distinct',
        ],
      };

    case DenialCategory.TIMELY_FILING:
      return {
        suggestedAction: 'Appeal with proof of timely submission',
        correctionSteps: [
          'Gather proof of original submission (clearinghouse trace, acknowledgment)',
          'If original was filed timely, appeal with documentation',
          'If not filed timely, check for valid exceptions (e.g., retroactive eligibility)',
          `Note: filing limit for this payer is ${getPayerConfig(claim.payer.payerId)?.timelyFilingDays || 365} days`,
        ],
      };

    case DenialCategory.MEDICAL_NECESSITY:
      return {
        suggestedAction: 'Appeal with clinical documentation',
        correctionSteps: [
          'Request medical records/chart notes from the provider',
          'Review LCD/NCD policies for the denied service',
          'Prepare a letter of medical necessity from the treating provider',
          'Submit appeal with clinical documentation and peer-reviewed literature',
        ],
      };

    case DenialCategory.ELIGIBILITY:
      return {
        suggestedAction: 'Verify patient eligibility and resubmit or bill patient',
        correctionSteps: [
          'Run eligibility check for the date of service',
          'If patient had coverage, appeal with proof of eligibility',
          'If coverage terminated, check for other insurance',
          'If no coverage, route to patient billing',
        ],
      };

    case DenialCategory.BUNDLING:
      return {
        suggestedAction: 'Review CCI edits and correct coding',
        correctionSteps: [
          'Check CCI (Correct Coding Initiative) edits for the code combination',
          'Determine if modifier 59 or X{EPSU} modifier is appropriate',
          'Review documentation to confirm services were truly distinct',
          'If bundling is correct, adjust the claim; if not, appeal with documentation',
        ],
      };

    case DenialCategory.COORDINATION:
      return {
        suggestedAction: 'Determine correct payer order and resubmit',
        correctionSteps: [
          'Verify primary/secondary payer information with the patient',
          'If this should be billed to another payer first, resubmit accordingly',
          'Include primary payer EOB when billing secondary',
          'Contact the payer for COB resolution if needed',
        ],
      };

    default:
      return {
        suggestedAction: 'Review denial and determine appropriate action',
        correctionSteps: [
          'Review the specific denial reason code and remark codes',
          'Contact the payer for clarification if needed',
          'Determine if the claim should be corrected, appealed, or written off',
        ],
      };
  }
}
