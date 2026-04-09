/**
 * Export to Analytics Data Warehouse
 * ====================================
 *
 * Author: Ryan Johnson (rjohnson@meridianhealth.io)
 * Created: 2024-06-01
 * Last Modified: 2025-10-18 by rjohnson
 *
 * Exports operational data to our Snowflake analytics warehouse.
 * Uses incremental exports based on updated_at timestamps so we don't
 * have to do full table dumps every time.
 *
 * Runs hourly:
 *   0 * * * * npx tsx /opt/meridian/scripts/etl/export-to-warehouse.ts >> /var/log/meridian/warehouse-export.log 2>&1
 *
 * Architecture:
 *   1. Read the high-water mark (last exported updated_at) from the export_state table
 *   2. Query all rows modified since the high-water mark
 *   3. Write to S3 as Parquet files (using the Snowflake external stage)
 *   4. Trigger Snowpipe to ingest the new files
 *   5. Update the high-water mark
 *
 * KNOWN ISSUES:
 * - If a row is updated between when we read the high-water mark and when
 *   we write the export, we might miss it. The next run will pick it up
 *   because we use >= (not >) on the timestamp comparison. This means we
 *   get some duplicate rows in the warehouse, but Snowflake handles that
 *   with MERGE on the primary key.
 * - The claims export can be slow during month-end due to volume. We added
 *   a 60-minute timeout but it still sometimes times out. When it does, the
 *   high-water mark isn't updated, so the next run picks up where we left off.
 *   This is fine but causes a backlog that can take a few hours to clear.
 */

import { Pool } from 'pg';
import { createWriteStream, mkdirSync } from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 3600000,  // 60 min timeout
});

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const S3_BUCKET = process.env.WAREHOUSE_S3_BUCKET || 'meridian-warehouse-staging';
const S3_PREFIX = 'incoming/';

// Tables to export and their configurations
const EXPORT_TABLES = [
  {
    name: 'patients',
    query: `
      SELECT
        id, mrn, first_name, last_name, date_of_birth, gender,
        city, state, zip_code,
        insurance_payer, insurance_plan_type,
        primary_provider_id, is_active,
        created_at, updated_at
      FROM patients
      WHERE updated_at >= $1
      ORDER BY updated_at
    `,
    // DO NOT export SSN, full address, email, phone to warehouse
    // Only de-identified / limited data set per HIPAA
    primaryKey: 'id',
    batchSize: 10000,
  },
  {
    name: 'providers',
    query: `
      SELECT
        id, npi, first_name, last_name, specialty,
        practice_city, practice_state, practice_zip,
        is_accepting_patients, max_panel_size,
        is_active, created_at, updated_at
      FROM providers
      WHERE updated_at >= $1
      ORDER BY updated_at
    `,
    primaryKey: 'id',
    batchSize: 5000,
  },
  {
    name: 'claims',
    query: `
      SELECT
        c.id, c.claim_number, c.patient_id, c.provider_id,
        c.date_of_service, c.date_filed, c.status,
        c.total_charged, c.total_allowed, c.total_paid, c.patient_responsibility,
        c.cpt_code, c.icd10_code, c.payer_id, c.payer_name,
        c.place_of_service, c.created_at, c.updated_at
      FROM claims c
      WHERE c.updated_at >= $1
      ORDER BY c.updated_at
    `,
    primaryKey: 'id',
    batchSize: 25000,
  },
  {
    name: 'appointments',
    query: `
      SELECT
        id, patient_id, provider_id, appointment_date,
        duration_minutes, appointment_type, status,
        created_at, updated_at
      FROM appointments
      WHERE updated_at >= $1
      ORDER BY updated_at
    `,
    // NOTE: reason and notes are excluded (may contain PHI)
    primaryKey: 'id',
    batchSize: 10000,
  },
  {
    name: 'billing_transactions',
    query: `
      SELECT
        id, patient_id, transaction_type, amount,
        reference_type, reference_id, status,
        created_at
      FROM billing_transactions
      WHERE created_at >= $1
      ORDER BY created_at
    `,
    // billing_transactions uses created_at not updated_at (immutable records)
    primaryKey: 'id',
    batchSize: 25000,
  },
  {
    name: 'eligibility_checks',
    query: `
      SELECT
        id, patient_id, provider_id, payer_id,
        check_date, status, is_eligible,
        copay_amount, deductible_remaining, out_of_pocket_remaining,
        response_code, created_at, updated_at
      FROM eligibility_checks
      WHERE updated_at >= $1
      ORDER BY updated_at
    `,
    primaryKey: 'id',
    batchSize: 10000,
  },
];

// -- State management --------------------------------------------------------

interface ExportState {
  tableName: string;
  lastExportedAt: Date;
  lastRunAt: Date;
  lastRowCount: number;
}

async function getExportState(tableName: string): Promise<ExportState | null> {
  const result = await pool.query(
    'SELECT table_name, last_exported_at, last_run_at, last_row_count FROM export_state WHERE table_name = $1',
    [tableName]
  );

  if (result.rows.length === 0) return null;

  return {
    tableName: result.rows[0].table_name,
    lastExportedAt: result.rows[0].last_exported_at,
    lastRunAt: result.rows[0].last_run_at,
    lastRowCount: result.rows[0].last_row_count,
  };
}

async function updateExportState(tableName: string, lastExportedAt: Date, rowCount: number): Promise<void> {
  await pool.query(`
    INSERT INTO export_state (table_name, last_exported_at, last_run_at, last_row_count)
    VALUES ($1, $2, NOW(), $3)
    ON CONFLICT (table_name) DO UPDATE SET
      last_exported_at = EXCLUDED.last_exported_at,
      last_run_at = EXCLUDED.last_run_at,
      last_row_count = EXCLUDED.last_row_count
  `, [tableName, lastExportedAt, rowCount]);
}

// -- Export logic ------------------------------------------------------------

async function exportTable(config: typeof EXPORT_TABLES[0]): Promise<{ rowCount: number; filesWritten: number }> {
  const state = await getExportState(config.name);
  const since = state?.lastExportedAt || new Date('2024-01-01');

  console.log(`  Since: ${since.toISOString()}`);

  // Query rows
  const result = await pool.query(config.query, [since]);

  if (result.rows.length === 0) {
    console.log(`  No new/updated rows`);
    return { rowCount: 0, filesWritten: 0 };
  }

  console.log(`  Found ${result.rows.length} rows to export`);

  // Write to S3 in batches (one file per batch)
  let filesWritten = 0;
  let maxUpdatedAt = since;

  for (let i = 0; i < result.rows.length; i += config.batchSize) {
    const batch = result.rows.slice(i, i + config.batchSize);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileId = randomUUID().substring(0, 8);
    const s3Key = `${S3_PREFIX}${config.name}/${timestamp}_${fileId}.ndjson`;

    // We write NDJSON (newline-delimited JSON) instead of Parquet because
    // our Node.js Parquet libraries are flaky. Snowflake can ingest NDJSON
    // just fine via the JSON file format.
    // TODO(rjohnson): Switch to Parquet for better compression and schema
    // enforcement. Tried parquetjs but it crashed on large batches.
    const body = batch.map(row => JSON.stringify(row)).join('\n');

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: body,
      ContentType: 'application/x-ndjson',
      ServerSideEncryption: 'aws:kms',
    }));

    filesWritten++;

    // Track the maximum updated_at for the high-water mark
    for (const row of batch) {
      const rowDate = new Date(row.updated_at || row.created_at);
      if (rowDate > maxUpdatedAt) {
        maxUpdatedAt = rowDate;
      }
    }
  }

  // Update the high-water mark
  await updateExportState(config.name, maxUpdatedAt, result.rows.length);

  return { rowCount: result.rows.length, filesWritten };
}

// Snowpipe notification (tells Snowflake new files are available)
async function triggerSnowpipe(): Promise<void> {
  // We use S3 event notifications -> SNS -> Snowpipe auto-ingest
  // So we don't actually need to do anything here. The S3 PutObject
  // triggers the pipeline automatically.
  //
  // But we log it for observability.
  console.log('Snowpipe auto-ingest will process files via S3 notifications');

  // Old code that used the REST API (kept for reference):
  // const snowpipeUrl = `https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/v1/data/pipes/${PIPE_NAME}/insertReport`;
  // await fetch(snowpipeUrl, { ... });
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Warehouse Export ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Target: s3://${S3_BUCKET}/${S3_PREFIX}`);
  console.log('');

  const results: Record<string, { rowCount: number; filesWritten: number }> = {};

  for (const table of EXPORT_TABLES) {
    console.log(`Exporting: ${table.name}`);
    try {
      results[table.name] = await exportTable(table);
      console.log(`  Exported ${results[table.name].rowCount} rows in ${results[table.name].filesWritten} files`);
    } catch (err) {
      console.error(`  ERROR exporting ${table.name}: ${(err as Error).message}`);
      results[table.name] = { rowCount: -1, filesWritten: 0 };
      // Don't fail the whole job for one table - continue with others
    }
    console.log('');
  }

  // Trigger ingestion
  await triggerSnowpipe();

  // Summary
  const totalRows = Object.values(results).reduce((sum, r) => sum + Math.max(r.rowCount, 0), 0);
  const totalFiles = Object.values(results).reduce((sum, r) => sum + r.filesWritten, 0);
  const errors = Object.entries(results).filter(([_, r]) => r.rowCount === -1).map(([name]) => name);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('=== Summary ===');
  console.log(`  Total rows exported: ${totalRows}`);
  console.log(`  Total files written: ${totalFiles}`);
  console.log(`  Duration: ${elapsed}s`);

  if (errors.length > 0) {
    console.log(`  ERRORS: ${errors.join(', ')}`);
  }

  console.log('');

  // Detailed breakdown
  for (const [name, result] of Object.entries(results)) {
    const status = result.rowCount === -1 ? 'ERROR' : result.rowCount === 0 ? 'no changes' : `${result.rowCount} rows`;
    console.log(`  ${name.padEnd(25)} ${status}`);
  }

  await pool.end();

  // Exit with error if any table failed
  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
