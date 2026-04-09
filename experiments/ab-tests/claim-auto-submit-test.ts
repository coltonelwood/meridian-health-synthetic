/**
 * A/B Test: Automatic Claim Submission
 * ======================================
 *
 * Test ID: AB-2025-012
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Created: 2025-10-15
 * Status: RUNNING (as of 2026-02-01)
 *
 * HYPOTHESIS:
 * Automatically submitting claims when all required fields are complete will:
 * 1. Reduce claim submission lag (time between service and submission) by 40%
 * 2. Reduce claim denial rate by 20% (less human error in submissions)
 * 3. Not increase the rate of claims needing manual review by more than 5%
 *
 * SAFETY GUARDRAILS:
 * - Auto-submit only fires if ALL required fields are populated
 * - Claims with charge amounts > $5,000 are held for manual review regardless
 * - Claims with unusual CPT/ICD-10 combinations are flagged for review
 * - Maximum of 50 auto-submissions per provider per day (prevents runaway)
 * - Auto-submit can be disabled per-provider via provider settings
 * - Kill switch via feature flag 'claim-auto-submit'
 *
 * CURRENT STATUS (2026-02-01, ajiang):
 * We're at 30% rollout. Early results look promising:
 *   - Submission lag dropped from 3.2 days to 0.8 days (treatment group)
 *   - Denial rate: 8.1% control vs 6.9% treatment (not yet significant, p=0.08)
 *   - Manual review rate: 12% control vs 14% treatment (acceptable)
 * Planning to ramp to 50% in February if metrics hold.
 *
 * VARIANTS:
 *   Control (A): Manual claim submission (current behavior)
 *   Treatment (B): Auto-submit when all fields complete + guardrails
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const TEST_ID = 'AB-2025-012';
const ROLLOUT_PERCENTAGE = 30;  // Should match feature flag config

// Safety limits
const MAX_AUTO_SUBMIT_PER_PROVIDER_PER_DAY = 50;
const MAX_CHARGE_AMOUNT_FOR_AUTO_SUBMIT = 5000;

// CPT codes that should always require manual review
// (high-complexity or frequently denied codes)
const MANUAL_REVIEW_CPT_CODES = [
  '99291', '99292',  // critical care
  '99281', '99282', '99283', '99284', '99285',  // ER visits
  '27447',  // knee replacement
  '33533',  // CABG
  '47562', '47563',  // laparoscopic cholecystectomy
];

// -- Assignment --------------------------------------------------------------

export function isInTreatmentGroup(organizationId: string): boolean {
  const hash = createHash('md5')
    .update(`${TEST_ID}:${organizationId}`)
    .digest();
  const value = hash.readUInt32BE(0) % 100;
  return value < ROLLOUT_PERCENTAGE;
}

// -- Guardrail Checks --------------------------------------------------------

interface ClaimData {
  claimId: string;
  patientId: string;
  providerId: string;
  organizationId: string;
  dateOfService: Date;
  totalCharged: number;
  cptCodes: string[];
  icd10Codes: string[];
  payerId: string;
  hasAllRequiredFields: boolean;
}

interface GuardrailResult {
  canAutoSubmit: boolean;
  reason: string;
  requiresManualReview: boolean;
  reviewReason?: string;
}

async function checkGuardrails(claim: ClaimData): Promise<GuardrailResult> {
  // Check 1: All required fields must be populated
  if (!claim.hasAllRequiredFields) {
    return {
      canAutoSubmit: false,
      reason: 'missing_required_fields',
      requiresManualReview: false,
    };
  }

  // Check 2: Charge amount limit
  if (claim.totalCharged > MAX_CHARGE_AMOUNT_FOR_AUTO_SUBMIT) {
    return {
      canAutoSubmit: false,
      reason: 'charge_exceeds_limit',
      requiresManualReview: true,
      reviewReason: `Charge amount $${claim.totalCharged.toFixed(2)} exceeds auto-submit limit of $${MAX_CHARGE_AMOUNT_FOR_AUTO_SUBMIT}`,
    };
  }

  // Check 3: High-complexity CPT codes
  const manualReviewCPT = claim.cptCodes.filter(c => MANUAL_REVIEW_CPT_CODES.includes(c));
  if (manualReviewCPT.length > 0) {
    return {
      canAutoSubmit: false,
      reason: 'high_complexity_cpt',
      requiresManualReview: true,
      reviewReason: `High-complexity CPT code(s): ${manualReviewCPT.join(', ')}`,
    };
  }

  // Check 4: Daily auto-submit limit per provider
  const dailyCount = await pool.query(`
    SELECT count(*) as cnt
    FROM ab_test_events
    WHERE test_id = $1
      AND event_type = 'auto_submitted'
      AND metadata->>'providerId' = $2
      AND created_at >= CURRENT_DATE
  `, [TEST_ID, claim.providerId]);

  if (parseInt(dailyCount.rows[0].cnt) >= MAX_AUTO_SUBMIT_PER_PROVIDER_PER_DAY) {
    return {
      canAutoSubmit: false,
      reason: 'daily_limit_reached',
      requiresManualReview: false,
    };
  }

  // Check 5: Provider opted out
  const providerSetting = await pool.query(`
    SELECT settings->>'auto_submit_enabled' as auto_submit
    FROM providers
    WHERE id = $1
  `, [claim.providerId]);

  if (providerSetting.rows[0]?.auto_submit === 'false') {
    return {
      canAutoSubmit: false,
      reason: 'provider_opted_out',
      requiresManualReview: false,
    };
  }

  // Check 6: Unusual CPT/ICD-10 combination
  // We use a lookup table of "common" combinations. If the combination
  // hasn't been seen before (or is rare), flag it for review.
  const combinationCheck = await pool.query(`
    SELECT count(*) as cnt
    FROM claims
    WHERE cpt_code = ANY($1)
      AND icd10_code = ANY($2)
      AND status IN ('paid', 'approved')
      AND date_of_service >= NOW() - INTERVAL '12 months'
  `, [claim.cptCodes, claim.icd10Codes]);

  if (parseInt(combinationCheck.rows[0].cnt) < 10) {
    return {
      canAutoSubmit: false,
      reason: 'unusual_code_combination',
      requiresManualReview: true,
      reviewReason: `Uncommon CPT/ICD-10 combination (seen ${combinationCheck.rows[0].cnt} times in past 12 months)`,
    };
  }

  // All checks passed
  return {
    canAutoSubmit: true,
    reason: 'all_guardrails_passed',
    requiresManualReview: false,
  };
}

// -- Core Logic --------------------------------------------------------------

export async function evaluateAutoSubmit(claim: ClaimData): Promise<{
  shouldAutoSubmit: boolean;
  variant: string;
  guardrailResult: GuardrailResult;
}> {
  const variant = isInTreatmentGroup(claim.organizationId) ? 'treatment' : 'control';

  // Control group: never auto-submit
  if (variant === 'control') {
    return {
      shouldAutoSubmit: false,
      variant: 'control',
      guardrailResult: { canAutoSubmit: false, reason: 'control_group', requiresManualReview: false },
    };
  }

  // Treatment group: check guardrails
  const guardrailResult = await checkGuardrails(claim);

  // Log the evaluation (for analysis)
  await pool.query(`
    INSERT INTO ab_test_events (
      test_id, user_id, variant, event_type, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())
  `, [
    TEST_ID,
    claim.providerId,
    variant,
    guardrailResult.canAutoSubmit ? 'auto_submitted' : 'auto_submit_blocked',
    JSON.stringify({
      claimId: claim.claimId,
      providerId: claim.providerId,
      organizationId: claim.organizationId,
      totalCharged: claim.totalCharged,
      reason: guardrailResult.reason,
      requiresManualReview: guardrailResult.requiresManualReview,
      reviewReason: guardrailResult.reviewReason,
    }),
  ]);

  return {
    shouldAutoSubmit: guardrailResult.canAutoSubmit,
    variant,
    guardrailResult,
  };
}

// -- Monitoring (run periodically to check test health) ----------------------

async function monitorTestHealth(): Promise<void> {
  console.log(`=== A/B Test Health Check: ${TEST_ID} ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  // Check sample sizes
  for (const variant of ['control', 'treatment']) {
    const sampleSize = await pool.query(`
      SELECT count(DISTINCT metadata->>'organizationId') as org_count
      FROM ab_test_events
      WHERE test_id = $1 AND variant = $2
    `, [TEST_ID, variant]);

    console.log(`${variant}: ${sampleSize.rows[0].org_count} organizations`);
  }

  // Check for guardrail triggers today
  const todayGuardrails = await pool.query(`
    SELECT
      metadata->>'reason' as reason,
      count(*) as cnt
    FROM ab_test_events
    WHERE test_id = $1
      AND event_type = 'auto_submit_blocked'
      AND created_at >= CURRENT_DATE
    GROUP BY metadata->>'reason'
    ORDER BY cnt DESC
  `, [TEST_ID]);

  console.log('\nGuardrail triggers today:');
  for (const row of todayGuardrails.rows) {
    console.log(`  ${row.reason}: ${row.cnt}`);
  }

  // Check daily auto-submit volume
  const dailyVolume = await pool.query(`
    SELECT
      date_trunc('day', created_at) as day,
      count(*) as auto_submitted,
      count(*) FILTER (WHERE event_type = 'auto_submit_blocked') as blocked
    FROM ab_test_events
    WHERE test_id = $1
      AND created_at >= NOW() - INTERVAL '7 days'
    GROUP BY date_trunc('day', created_at)
    ORDER BY day DESC
  `, [TEST_ID]);

  console.log('\nDaily volume (last 7 days):');
  for (const row of dailyVolume.rows) {
    console.log(`  ${new Date(row.day).toISOString().split('T')[0]}: ${row.auto_submitted} submitted, ${row.blocked} blocked`);
  }

  // Alert if error rate in treatment is significantly worse than control
  // (this would trigger a discussion about pausing the test)
  const denialRates = await pool.query(`
    SELECT
      e.variant,
      count(*) as total_claims,
      count(*) FILTER (WHERE c.status = 'denied') as denied_claims
    FROM ab_test_events e
    JOIN claims c ON c.id = (e.metadata->>'claimId')::uuid
    WHERE e.test_id = $1
      AND e.event_type IN ('auto_submitted', 'auto_submit_blocked')
      AND e.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY e.variant
  `, [TEST_ID]);

  console.log('\nDenial rates (last 30 days):');
  for (const row of denialRates.rows) {
    const rate = parseInt(row.total_claims) > 0
      ? (parseInt(row.denied_claims) / parseInt(row.total_claims) * 100).toFixed(1)
      : 'N/A';
    console.log(`  ${row.variant}: ${rate}% (${row.denied_claims}/${row.total_claims})`);
  }
}

// -- CLI ---------------------------------------------------------------------

if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'monitor':
      monitorTestHealth().then(() => pool.end()).catch(console.error);
      break;
    case 'check-org':
      const orgId = process.argv[3];
      if (!orgId) { console.error('Usage: ... check-org <org-id>'); process.exit(1); }
      console.log(`Organization ${orgId}: ${isInTreatmentGroup(orgId) ? 'TREATMENT' : 'CONTROL'}`);
      pool.end();
      break;
    default:
      console.log('Usage: npx tsx claim-auto-submit-test.ts <monitor|check-org>');
      pool.end();
  }
}
