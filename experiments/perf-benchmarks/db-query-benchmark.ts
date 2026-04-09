/**
 * Database Query Benchmark
 * =========================
 *
 * Author: Kevin Park (kpark@meridianhealth.io)
 * Created: 2025-03-05
 * Last Modified: 2025-11-20 by kpark
 *
 * Benchmarks critical database queries against the production-like dataset.
 * Run this against the staging database which has a copy of production data
 * (minus PHI - uses the anonymized snapshot).
 *
 * Usage:
 *   npx tsx experiments/perf-benchmarks/db-query-benchmark.ts
 *   npx tsx experiments/perf-benchmarks/db-query-benchmark.ts --query patient-search
 *   npx tsx experiments/perf-benchmarks/db-query-benchmark.ts --all --iterations 100
 *
 * EXECUTION PLANS AND NOTES (from last run, 2025-11-20):
 *
 * patient-search: Uses the GIN trigram index on (first_name, last_name).
 *   Fast for exact matches but slower for partial matches. The ILIKE with
 *   leading wildcard can't use the B-tree index. Consider adding pg_trgm.
 *   Current: p95 = 45ms. Target: <30ms.
 *
 * claims-by-status: Sequential scan on claims table when status='pending'
 *   because ~15% of rows match. Postgres decides seq scan is faster than
 *   index scan at this selectivity. Fine for now but will be a problem when
 *   the table grows past 50M rows.
 *   Current: p95 = 120ms. Target: <100ms.
 *   NEEDS OPTIMIZATION: Consider partitioning claims by status or date.
 *
 * provider-schedule: Complex join across appointments + providers + facilities.
 *   Uses the composite index on (provider_id, appointment_date). Good plan.
 *   Current: p95 = 25ms. OK.
 *
 * patient-balance: Aggregation across billing_transactions. Currently does
 *   a full index scan on the patient_id index. Should be fine until we hit
 *   100M+ transactions. Consider materialized view.
 *   Current: p95 = 85ms. Target: <50ms.
 *   TODO(kpark): The denormalized balance on patients table was supposed to
 *   fix this but it keeps getting out of sync (see recalculate-balances.ts).
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://meridian:meridian@localhost:5432/meridian_staging',
});

// Parse args
const args = process.argv.slice(2);
let queryFilter = '';
let iterations = 50;
let showExplain = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--query') queryFilter = args[++i];
  if (args[i] === '--all') queryFilter = '';
  if (args[i] === '--iterations') iterations = parseInt(args[++i]);
  if (args[i] === '--explain') showExplain = true;
}

// -- Benchmark Queries -------------------------------------------------------

interface BenchmarkQuery {
  name: string;
  description: string;
  query: string;
  params: unknown[];
  expectedPlan?: string;  // notes about what the execution plan should look like
}

const QUERIES: BenchmarkQuery[] = [
  {
    name: 'patient-search',
    description: 'Search patients by name (partial match)',
    query: `
      SELECT id, mrn, first_name, last_name, date_of_birth, phone, insurance_payer
      FROM patients
      WHERE (first_name ILIKE $1 OR last_name ILIKE $1)
        AND is_active = true
      ORDER BY last_name, first_name
      LIMIT 25
    `,
    params: ['%john%'],
    expectedPlan: 'Should use GIN trigram index. If doing Seq Scan, check pg_trgm extension.',
  },
  {
    name: 'patient-search-exact',
    description: 'Search patients by exact last name + DOB',
    query: `
      SELECT id, mrn, first_name, last_name, date_of_birth, phone, insurance_payer
      FROM patients
      WHERE last_name = $1
        AND date_of_birth = $2
        AND is_active = true
      ORDER BY first_name
      LIMIT 25
    `,
    params: ['Smith', '1985-03-15'],
    expectedPlan: 'Should use composite index on (last_name, date_of_birth).',
  },
  {
    name: 'patient-by-mrn',
    description: 'Look up patient by MRN',
    query: `
      SELECT p.*, pp.id as portal_account_id
      FROM patients p
      LEFT JOIN patient_portal_accounts pp ON pp.patient_id = p.id AND pp.is_active = true
      WHERE p.mrn = $1
    `,
    params: ['MRN-12345678'],
    expectedPlan: 'Should use unique index on mrn. Sub-millisecond.',
  },
  {
    name: 'claims-by-status',
    description: 'Get pending claims for a payer with date range',
    query: `
      SELECT c.id, c.claim_number, c.patient_id, c.date_of_service,
             c.total_charged, c.payer_name, c.cpt_code, c.icd10_code,
             p.first_name, p.last_name, p.mrn
      FROM claims c
      JOIN patients p ON p.id = c.patient_id
      WHERE c.status = $1
        AND c.payer_id = $2
        AND c.date_filed >= $3
        AND c.date_filed < $4
      ORDER BY c.date_filed DESC
      LIMIT 50
    `,
    params: ['pending', 'BCBS001', '2025-10-01', '2025-11-01'],
    expectedPlan: 'Might seq scan claims if too many pending. Index on (status, payer_id, date_filed) would help.',
  },
  {
    name: 'claims-by-patient',
    description: 'Get all claims for a patient (claim history)',
    query: `
      SELECT c.id, c.claim_number, c.date_of_service, c.status,
             c.total_charged, c.total_paid, c.patient_responsibility,
             c.cpt_code, c.cpt_description, c.payer_name
      FROM claims c
      WHERE c.patient_id = $1
      ORDER BY c.date_of_service DESC
    `,
    params: ['00000000-0000-0000-0000-000000000001'],  // placeholder
    expectedPlan: 'Should use index on patient_id. Fast for individual patient lookups.',
  },
  {
    name: 'provider-schedule',
    description: 'Get provider schedule for a day',
    query: `
      SELECT a.id, a.appointment_date, a.duration_minutes, a.appointment_type, a.status,
             p.id as patient_id, p.first_name, p.last_name, p.mrn, p.phone,
             a.reason, a.notes
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      WHERE a.provider_id = $1
        AND a.appointment_date >= $2
        AND a.appointment_date < $3
        AND a.status != 'cancelled'
      ORDER BY a.appointment_date
    `,
    params: ['00000000-0000-0000-0000-000000000001', '2025-11-20', '2025-11-21'],
    expectedPlan: 'Should use composite index on (provider_id, appointment_date). Fast.',
  },
  {
    name: 'patient-balance',
    description: 'Calculate patient account balance from transactions',
    query: `
      SELECT
        SUM(CASE
          WHEN transaction_type IN ('charge', 'late_fee') THEN amount
          WHEN transaction_type IN ('payment', 'insurance_payment', 'adjustment', 'write_off') THEN -amount
          ELSE 0
        END) as calculated_balance,
        COUNT(*) as transaction_count,
        MAX(created_at) as last_transaction
      FROM billing_transactions
      WHERE patient_id = $1
        AND status != 'voided'
    `,
    params: ['00000000-0000-0000-0000-000000000001'],
    expectedPlan: 'Index scan on patient_id. Aggregation in memory. Watch for patients with 1000+ transactions.',
  },
  {
    name: 'appointment-availability',
    description: 'Find available appointment slots for a provider',
    query: `
      WITH booked_slots AS (
        SELECT appointment_date, duration_minutes
        FROM appointments
        WHERE provider_id = $1
          AND appointment_date >= $2
          AND appointment_date < $3
          AND status NOT IN ('cancelled', 'no-show')
      )
      SELECT gs.slot_time
      FROM generate_series($2::timestamp, $3::timestamp - interval '30 minutes', interval '30 minutes') as gs(slot_time)
      WHERE NOT EXISTS (
        SELECT 1 FROM booked_slots b
        WHERE gs.slot_time >= b.appointment_date
          AND gs.slot_time < b.appointment_date + (b.duration_minutes || ' minutes')::interval
      )
      AND EXTRACT(DOW FROM gs.slot_time) BETWEEN 1 AND 5  -- weekdays only
      AND EXTRACT(HOUR FROM gs.slot_time) BETWEEN 8 AND 16  -- business hours
      ORDER BY gs.slot_time
      LIMIT 20
    `,
    params: ['00000000-0000-0000-0000-000000000001', '2025-11-20', '2025-11-25'],
    expectedPlan: 'Uses generate_series with anti-join. Fast for single-day, slower for week-long ranges.',
  },
  {
    name: 'dashboard-stats',
    description: 'Dashboard summary stats (today)',
    query: `
      SELECT
        (SELECT count(*) FROM appointments WHERE appointment_date >= CURRENT_DATE AND appointment_date < CURRENT_DATE + 1 AND status != 'cancelled') as today_appointments,
        (SELECT count(*) FROM appointments WHERE appointment_date >= CURRENT_DATE AND appointment_date < CURRENT_DATE + 1 AND status = 'checked-in') as checked_in,
        (SELECT count(*) FROM appointments WHERE appointment_date >= CURRENT_DATE AND appointment_date < CURRENT_DATE + 1 AND status = 'no-show') as no_shows,
        (SELECT count(*) FROM claims WHERE status = 'pending' AND date_filed >= CURRENT_DATE - 30) as pending_claims,
        (SELECT count(*) FROM claims WHERE status = 'denied' AND date_filed >= CURRENT_DATE - 30) as denied_claims_30d,
        (SELECT count(*) FROM eligibility_checks WHERE check_date >= CURRENT_DATE AND status = 'failed') as failed_eligibility_today
    `,
    params: [],
    expectedPlan: 'Multiple subqueries. Each should use respective indexes. Total time depends on table sizes.',
  },
  {
    name: 'audit-log-search',
    description: 'Search audit log by user and date range',
    query: `
      SELECT al.id, al.created_at, al.action, al.resource_type, al.resource_id,
             al.patient_id, al.ip_address, u.email
      FROM audit_log al
      JOIN users u ON u.id = al.user_id
      WHERE al.user_id = $1
        AND al.created_at >= $2
        AND al.created_at < $3
      ORDER BY al.created_at DESC
      LIMIT 100
    `,
    params: ['00000000-0000-0000-0000-000000000001', '2025-11-01', '2025-11-21'],
    expectedPlan: 'Should use composite index on (user_id, created_at). Audit_log is huge so index is critical.',
  },
];

// -- Benchmark Runner --------------------------------------------------------

interface BenchmarkResult {
  name: string;
  iterations: number;
  durations: number[];
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  rowsReturned: number;
}

async function runBenchmark(query: BenchmarkQuery): Promise<BenchmarkResult> {
  const durations: number[] = [];
  let rowsReturned = 0;

  // Warm up (3 iterations, not counted)
  for (let i = 0; i < 3; i++) {
    await pool.query(query.query, query.params);
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    const result = await pool.query(query.query, query.params);
    const end = process.hrtime.bigint();

    const durationMs = Number(end - start) / 1_000_000;
    durations.push(durationMs);
    rowsReturned = result.rows.length;
  }

  durations.sort((a, b) => a - b);

  return {
    name: query.name,
    iterations,
    durations,
    p50: durations[Math.floor(durations.length * 0.5)],
    p95: durations[Math.floor(durations.length * 0.95)],
    p99: durations[Math.floor(durations.length * 0.99)],
    min: durations[0],
    max: durations[durations.length - 1],
    mean: durations.reduce((a, b) => a + b, 0) / durations.length,
    rowsReturned,
  };
}

async function showExplainPlan(query: BenchmarkQuery): Promise<void> {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query.query}`, query.params);
  console.log(`\n--- EXPLAIN ANALYZE: ${query.name} ---`);
  for (const row of result.rows) {
    console.log(`  ${row['QUERY PLAN']}`);
  }
  if (query.expectedPlan) {
    console.log(`  Expected: ${query.expectedPlan}`);
  }
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Database Query Benchmark ===');
  console.log(`Database: ${process.env.DATABASE_URL || 'localhost:5432/meridian_staging'}`);
  console.log(`Iterations: ${iterations}`);
  console.log('');

  const queriesToRun = queryFilter
    ? QUERIES.filter(q => q.name === queryFilter)
    : QUERIES;

  if (queriesToRun.length === 0) {
    console.error(`Query '${queryFilter}' not found. Available:`);
    for (const q of QUERIES) {
      console.error(`  ${q.name}: ${q.description}`);
    }
    process.exit(1);
  }

  // Run benchmarks
  const results: BenchmarkResult[] = [];

  for (const query of queriesToRun) {
    process.stdout.write(`Running: ${query.name}...`);
    try {
      const result = await runBenchmark(query);
      results.push(result);
      console.log(` p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms p99=${result.p99.toFixed(1)}ms`);

      if (showExplain) {
        await showExplainPlan(query);
      }
    } catch (err) {
      console.log(` ERROR: ${(err as Error).message}`);
    }
  }

  // Summary table
  console.log('');
  console.log('='.repeat(95));
  console.log(`${'Query'.padEnd(30)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'min'.padStart(8)} ${'max'.padStart(8)} ${'mean'.padStart(8)} ${'rows'.padStart(6)}`);
  console.log('-'.repeat(95));

  for (const r of results) {
    const flag = r.p95 > 100 ? ' SLOW' : '';
    console.log(
      `${r.name.padEnd(30)} ${(r.p50.toFixed(1) + 'ms').padStart(8)} ${(r.p95.toFixed(1) + 'ms').padStart(8)} ` +
      `${(r.p99.toFixed(1) + 'ms').padStart(8)} ${(r.min.toFixed(1) + 'ms').padStart(8)} ` +
      `${(r.max.toFixed(1) + 'ms').padStart(8)} ${(r.mean.toFixed(1) + 'ms').padStart(8)} ${String(r.rowsReturned).padStart(6)}${flag}`
    );
  }

  console.log('');

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
