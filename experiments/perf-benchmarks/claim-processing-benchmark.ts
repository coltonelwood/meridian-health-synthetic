/**
 * Claim Processing Pipeline Benchmark
 * =====================================
 *
 * Author: Ryan Johnson (rjohnson@meridianhealth.io)
 * Created: 2025-06-20
 * Last Modified: 2025-11-30 by rjohnson
 *
 * Benchmarks the end-to-end claim processing pipeline throughput.
 * This is the pipeline that takes a claim from submission through
 * validation, scrubbing, and submission to the clearinghouse.
 *
 * The pipeline stages are:
 *   1. Intake & Parse - Parse incoming claim (EDI 837 or JSON)
 *   2. Validation - Check required fields, code validity, patient eligibility
 *   3. Scrubbing - Run claim edits (CCI, MUE, LCD, NCD)
 *   4. Pricing - Apply fee schedule and contracted rates
 *   5. Batching - Group claims by payer for submission
 *   6. Submission - Submit to clearinghouse (simulated in benchmark)
 *
 * BASELINE NUMBERS (from 2025-11-30 run):
 * =========================================
 * Stage               Avg/claim   p95/claim   Throughput
 * Intake & Parse       2.1ms       5.8ms      475 claims/sec
 * Validation           8.3ms      22.1ms      120 claims/sec  <-- bottleneck
 * Scrubbing            5.7ms      14.2ms      175 claims/sec
 * Pricing              3.2ms       8.5ms      310 claims/sec
 * Batching             1.1ms       2.8ms      910 claims/sec
 * Submission (sim)     0.5ms       1.2ms      2000 claims/sec
 *
 * End-to-End:          21ms       55ms        ~47 claims/sec
 *
 * BOTTLENECK: Validation is the slowest stage. It does 3 sequential DB
 * lookups: (1) patient exists, (2) provider is active, (3) code validity.
 * These could be parallelized (see PERF-512).
 *
 * TARGET: 100 claims/sec end-to-end (we're at 47, need ~2x improvement).
 * This target comes from our SLA with large provider groups who do batch
 * submissions of 10,000+ claims at month-end.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://meridian:meridian@localhost:5432/meridian_staging',
});

// -- Simulated Pipeline Stages -----------------------------------------------

interface ClaimInput {
  id: string;
  patientId: string;
  providerId: string;
  dateOfService: string;
  cptCodes: string[];
  icd10Codes: string[];
  chargeAmount: number;
  payerId: string;
}

interface StageResult {
  stage: string;
  durationMs: number;
  success: boolean;
  errors: string[];
}

interface PipelineResult {
  claimId: string;
  stages: StageResult[];
  totalDurationMs: number;
  success: boolean;
}

// Stage 1: Intake & Parse
async function stageIntake(claim: ClaimInput): Promise<StageResult> {
  const start = process.hrtime.bigint();

  // Simulate parsing (in reality, this would parse EDI 837P format)
  // Just validate basic structure
  const errors: string[] = [];
  if (!claim.patientId) errors.push('Missing patient ID');
  if (!claim.providerId) errors.push('Missing provider ID');
  if (!claim.cptCodes.length) errors.push('No CPT codes');
  if (!claim.icd10Codes.length) errors.push('No ICD-10 codes');

  // Simulate some CPU work (JSON serialization/deserialization)
  JSON.parse(JSON.stringify(claim));

  const duration = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    stage: 'intake',
    durationMs: duration,
    success: errors.length === 0,
    errors,
  };
}

// Stage 2: Validation
async function stageValidation(claim: ClaimInput): Promise<StageResult> {
  const start = process.hrtime.bigint();
  const errors: string[] = [];

  // These 3 queries are the bottleneck - they're sequential right now
  // TODO(PERF-512): Run these in parallel with Promise.all

  // Check 1: Patient exists and is active
  const patientResult = await pool.query(
    'SELECT id, is_active FROM patients WHERE id = $1',
    [claim.patientId]
  );
  if (patientResult.rows.length === 0) {
    errors.push('Patient not found');
  } else if (!patientResult.rows[0].is_active) {
    errors.push('Patient is inactive');
  }

  // Check 2: Provider is active and has valid NPI
  const providerResult = await pool.query(
    'SELECT id, npi, is_active FROM providers WHERE id = $1',
    [claim.providerId]
  );
  if (providerResult.rows.length === 0) {
    errors.push('Provider not found');
  } else if (!providerResult.rows[0].is_active) {
    errors.push('Provider is inactive');
  }

  // Check 3: Codes are valid
  for (const cpt of claim.cptCodes) {
    const cptResult = await pool.query(
      'SELECT code FROM cpt_codes WHERE code = $1 AND is_active = true',
      [cpt]
    );
    if (cptResult.rows.length === 0) {
      errors.push(`Invalid CPT code: ${cpt}`);
    }
  }

  const duration = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    stage: 'validation',
    durationMs: duration,
    success: errors.length === 0,
    errors,
  };
}

// Stage 3: Scrubbing (claim edits)
async function stageScrubbing(claim: ClaimInput): Promise<StageResult> {
  const start = process.hrtime.bigint();
  const errors: string[] = [];

  // CCI (Correct Coding Initiative) edits
  // Check for code pair conflicts
  if (claim.cptCodes.length > 1) {
    const cciResult = await pool.query(`
      SELECT code1, code2, modifier_allowed
      FROM cci_edits
      WHERE code1 = ANY($1) AND code2 = ANY($1)
        AND effective_date <= $2
        AND (termination_date IS NULL OR termination_date > $2)
    `, [claim.cptCodes, claim.dateOfService]);

    for (const row of cciResult.rows) {
      errors.push(`CCI conflict: ${row.code1} + ${row.code2}`);
    }
  }

  // MUE (Medically Unlikely Edits)
  // Check units don't exceed MUE limits
  // (simplified - in production we check per-line units)
  const mueResult = await pool.query(`
    SELECT code, max_units
    FROM mue_limits
    WHERE code = ANY($1)
  `, [claim.cptCodes]);

  // Simulated processing time for additional edits
  await new Promise(r => setTimeout(r, 1));

  const duration = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    stage: 'scrubbing',
    durationMs: duration,
    success: errors.length === 0,
    errors,
  };
}

// Stage 4: Pricing
async function stagePricing(claim: ClaimInput): Promise<StageResult> {
  const start = process.hrtime.bigint();

  // Look up fee schedule
  const feeResult = await pool.query(`
    SELECT code, allowed_amount
    FROM fee_schedules
    WHERE payer_id = $1
      AND code = ANY($2)
      AND effective_date <= $3
    ORDER BY effective_date DESC
  `, [claim.payerId, claim.cptCodes, claim.dateOfService]);

  // Simulate pricing calculation
  let _totalAllowed = 0;
  for (const row of feeResult.rows) {
    _totalAllowed += parseFloat(row.allowed_amount || '0');
  }

  const duration = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    stage: 'pricing',
    durationMs: duration,
    success: true,
    errors: [],
  };
}

// Stage 5: Batching
async function stageBatching(_claim: ClaimInput): Promise<StageResult> {
  const start = process.hrtime.bigint();

  // Simulate batching logic (grouping by payer, formatting)
  // In production this builds EDI 837 segments
  const _batch = {
    payerId: _claim.payerId,
    claimCount: 1,
    totalCharged: _claim.chargeAmount,
  };

  const duration = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    stage: 'batching',
    durationMs: duration,
    success: true,
    errors: [],
  };
}

// Stage 6: Submission (simulated)
async function stageSubmission(_claim: ClaimInput): Promise<StageResult> {
  const start = process.hrtime.bigint();

  // In production this sends to the clearinghouse via SFTP or API
  // Here we just simulate the overhead
  const _submissionId = randomUUID();

  const duration = Number(process.hrtime.bigint() - start) / 1_000_000;

  return {
    stage: 'submission',
    durationMs: duration,
    success: true,
    errors: [],
  };
}

// -- Pipeline Runner ---------------------------------------------------------

async function processClaim(claim: ClaimInput): Promise<PipelineResult> {
  const startTime = process.hrtime.bigint();
  const stages: StageResult[] = [];

  // Run stages sequentially (as in production)
  const intake = await stageIntake(claim);
  stages.push(intake);
  if (!intake.success) {
    return {
      claimId: claim.id,
      stages,
      totalDurationMs: Number(process.hrtime.bigint() - startTime) / 1_000_000,
      success: false,
    };
  }

  const validation = await stageValidation(claim);
  stages.push(validation);
  if (!validation.success) {
    return {
      claimId: claim.id,
      stages,
      totalDurationMs: Number(process.hrtime.bigint() - startTime) / 1_000_000,
      success: false,
    };
  }

  const scrubbing = await stageScrubbing(claim);
  stages.push(scrubbing);
  // Scrubbing errors don't stop the pipeline - they flag the claim for review

  const pricing = await stagePricing(claim);
  stages.push(pricing);

  const batching = await stageBatching(claim);
  stages.push(batching);

  const submission = await stageSubmission(claim);
  stages.push(submission);

  return {
    claimId: claim.id,
    stages,
    totalDurationMs: Number(process.hrtime.bigint() - startTime) / 1_000_000,
    success: true,
  };
}

// -- Generate test claims ----------------------------------------------------

function generateTestClaim(): ClaimInput {
  return {
    id: randomUUID(),
    patientId: randomUUID(),  // won't exist in DB, which is fine for benchmarking the query itself
    providerId: randomUUID(),
    dateOfService: '2025-11-15',
    cptCodes: ['99213'],
    icd10Codes: ['J06.9'],
    chargeAmount: 95.00,
    payerId: 'BCBS001',
  };
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const claimCount = parseInt(process.argv[2] || '500');

  console.log('=== Claim Processing Pipeline Benchmark ===');
  console.log(`Claims to process: ${claimCount}`);
  console.log('');

  // Generate test claims
  const claims = Array.from({ length: claimCount }, generateTestClaim);

  // Process all claims and collect results
  const results: PipelineResult[] = [];
  const overallStart = Date.now();

  for (let i = 0; i < claims.length; i++) {
    const result = await processClaim(claims[i]);
    results.push(result);

    if ((i + 1) % 100 === 0) {
      const elapsed = ((Date.now() - overallStart) / 1000).toFixed(1);
      const rps = ((i + 1) / parseFloat(elapsed)).toFixed(1);
      process.stdout.write(`\r  Processed ${i + 1}/${claimCount} (${rps} claims/sec)`);
    }
  }

  const overallDuration = (Date.now() - overallStart) / 1000;
  console.log('\n');

  // Analyze results by stage
  const stageNames = ['intake', 'validation', 'scrubbing', 'pricing', 'batching', 'submission'];

  console.log('='.repeat(80));
  console.log(`${'Stage'.padEnd(20)} ${'Avg'.padStart(10)} ${'p50'.padStart(10)} ${'p95'.padStart(10)} ${'p99'.padStart(10)} ${'Through'.padStart(12)}`);
  console.log('-'.repeat(80));

  for (const stageName of stageNames) {
    const stageDurations = results
      .flatMap(r => r.stages)
      .filter(s => s.stage === stageName)
      .map(s => s.durationMs)
      .sort((a, b) => a - b);

    if (stageDurations.length === 0) continue;

    const avg = stageDurations.reduce((a, b) => a + b, 0) / stageDurations.length;
    const p50 = stageDurations[Math.floor(stageDurations.length * 0.5)];
    const p95 = stageDurations[Math.floor(stageDurations.length * 0.95)];
    const p99 = stageDurations[Math.floor(stageDurations.length * 0.99)];
    const throughput = (1000 / avg).toFixed(0);

    console.log(
      `${stageName.padEnd(20)} ${(avg.toFixed(1) + 'ms').padStart(10)} ${(p50.toFixed(1) + 'ms').padStart(10)} ` +
      `${(p95.toFixed(1) + 'ms').padStart(10)} ${(p99.toFixed(1) + 'ms').padStart(10)} ${(throughput + '/sec').padStart(12)}`
    );
  }

  // End-to-end stats
  const totalDurations = results.map(r => r.totalDurationMs).sort((a, b) => a - b);
  const avgTotal = totalDurations.reduce((a, b) => a + b, 0) / totalDurations.length;
  const p50Total = totalDurations[Math.floor(totalDurations.length * 0.5)];
  const p95Total = totalDurations[Math.floor(totalDurations.length * 0.95)];

  console.log('-'.repeat(80));
  console.log(
    `${'END-TO-END'.padEnd(20)} ${(avgTotal.toFixed(1) + 'ms').padStart(10)} ${(p50Total.toFixed(1) + 'ms').padStart(10)} ` +
    `${(p95Total.toFixed(1) + 'ms').padStart(10)} ${(totalDurations[Math.floor(totalDurations.length * 0.99)].toFixed(1) + 'ms').padStart(10)} ` +
    `${((1000 / avgTotal).toFixed(0) + '/sec').padStart(12)}`
  );

  console.log('');
  console.log(`Total time: ${overallDuration.toFixed(1)}s`);
  console.log(`Overall throughput: ${(claimCount / overallDuration).toFixed(1)} claims/sec`);
  console.log(`Success rate: ${(results.filter(r => r.success).length / results.length * 100).toFixed(1)}%`);

  const targetRps = 100;
  const actualRps = claimCount / overallDuration;
  console.log('');
  console.log(`Target: ${targetRps} claims/sec`);
  console.log(`Actual: ${actualRps.toFixed(1)} claims/sec`);
  console.log(`Gap: ${actualRps >= targetRps ? 'MEETING TARGET' : `${((1 - actualRps / targetRps) * 100).toFixed(0)}% below target`}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
