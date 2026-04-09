/**
 * Backfill Missing Insurance IDs
 * ===============================
 *
 * Date: 2024-06-22
 * Author: Marcus Rodriguez (mrodriguez@meridianhealth.io)
 * Ticket: DATA-1523 (https://meridian.atlassian.net/browse/DATA-1523)
 *
 * CONTEXT:
 * When we migrated from the old ClaimsMaster system (May 2024), about 12,000
 * patient records came over without their insurance_payer_id field populated.
 * The old system stored insurance info in a completely different schema and
 * the ETL script (which was written by a contractor who has since left) missed
 * this mapping.
 *
 * The compliance team extracted a CSV from ClaimsMaster with the mapping:
 *   old_patient_id -> payer_id, member_id, group_number
 *
 * This script reads that CSV and backfills the missing data, using an
 * intermediate mapping table (patient_id_crossref) that was built during
 * the original migration.
 *
 * RUN:
 *   npx tsx scripts/data-fixes/backfill-insurance-ids.ts --file /path/to/insurance-export.csv
 *   npx tsx scripts/data-fixes/backfill-insurance-ids.ts --file /path/to/insurance-export.csv --dry-run
 */

import { Pool } from 'pg';
import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import { Transform } from 'stream';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

interface InsuranceRecord {
  oldPatientId: string;
  payerName: string;
  payerId: string;
  memberId: string;
  groupNumber: string;
  planType: string;
}

// -- Parse CLI args ----------------------------------------------------------
const args = process.argv.slice(2);
let csvFile = '';
let dryRun = false;
let batchSize = 100;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--file':
      csvFile = args[++i];
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '--batch-size':
      batchSize = parseInt(args[++i]);
      break;
  }
}

if (!csvFile) {
  console.error('Usage: npx tsx backfill-insurance-ids.ts --file <csv-path> [--dry-run] [--batch-size N]');
  process.exit(1);
}

// -- Main logic --------------------------------------------------------------

async function loadCSV(filePath: string): Promise<InsuranceRecord[]> {
  return new Promise((resolve, reject) => {
    const records: InsuranceRecord[] = [];

    createReadStream(filePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        // The CSV from ClaimsMaster has these headers (ugh, spaces in column names):
        //   "Patient ID", "Payer Name", "Payer ID", "Member ID", "Group #", "Plan Type"
        // csv-parse handles this fine with columns:true
      }))
      .on('data', (row: Record<string, string>) => {
        records.push({
          oldPatientId: row['Patient ID'] || row['patient_id'],
          payerName: row['Payer Name'] || row['payer_name'],
          payerId: row['Payer ID'] || row['payer_id'],
          memberId: row['Member ID'] || row['member_id'],
          groupNumber: row['Group #'] || row['group_number'] || '',
          planType: row['Plan Type'] || row['plan_type'] || 'Unknown',
        });
      })
      .on('end', () => resolve(records))
      .on('error', reject);
  });
}

async function resolveNewPatientId(oldId: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT new_patient_id FROM patient_id_crossref WHERE old_patient_id = $1',
    [oldId]
  );
  return result.rows[0]?.new_patient_id || null;
}

async function main(): Promise<void> {
  console.log('=== Backfill Insurance IDs ===');
  console.log(`CSV: ${csvFile}`);
  console.log(`Dry Run: ${dryRun}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log('');

  // Load CSV
  console.log('Loading CSV...');
  const records = await loadCSV(csvFile);
  console.log(`Loaded ${records.length} records from CSV`);

  // Stats
  let processed = 0;
  let updated = 0;
  let skippedNoMapping = 0;
  let skippedAlreadySet = 0;
  let skippedNotFound = 0;
  let errors = 0;

  const startTime = Date.now();
  const client = await pool.connect();

  try {
    if (!dryRun) {
      await client.query('BEGIN');
    }

    for (const record of records) {
      processed++;

      // Progress logging every 500 records
      if (processed % 500 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (processed / parseFloat(elapsed)).toFixed(0);
        console.log(`  Progress: ${processed}/${records.length} (${rate}/s) - Updated: ${updated}, Skipped: ${skippedNoMapping + skippedAlreadySet + skippedNotFound}, Errors: ${errors}`);
      }

      try {
        // Map old patient ID to new patient ID
        const newPatientId = await resolveNewPatientId(record.oldPatientId);

        if (!newPatientId) {
          skippedNoMapping++;
          continue;
        }

        // Check if patient exists and what their current insurance state is
        const existing = await client.query(
          'SELECT id, insurance_payer_id, insurance_member_id FROM patients WHERE id = $1',
          [newPatientId]
        );

        if (existing.rows.length === 0) {
          skippedNotFound++;
          continue;
        }

        // Skip if insurance is already populated
        // (some records were fixed manually by the ops team before this script was ready)
        if (existing.rows[0].insurance_payer_id && existing.rows[0].insurance_member_id) {
          skippedAlreadySet++;
          continue;
        }

        // Update the patient record
        if (!dryRun) {
          await client.query(`
            UPDATE patients
            SET insurance_payer = $1,
                insurance_payer_id = $2,
                insurance_member_id = $3,
                insurance_group_number = $4,
                insurance_plan_type = $5,
                updated_at = NOW()
            WHERE id = $6
              AND (insurance_payer_id IS NULL OR insurance_member_id IS NULL)
          `, [
            record.payerName,
            record.payerId,
            record.memberId,
            record.groupNumber,
            record.planType,
            newPatientId,
          ]);
        }

        updated++;

      } catch (err) {
        errors++;
        console.error(`  ERROR processing old_id=${record.oldPatientId}: ${(err as Error).message}`);
        // Don't fail the whole batch for one bad record
      }
    }

    if (!dryRun) {
      console.log('\nCommitting...');
      await client.query('COMMIT');
    }

  } catch (err) {
    if (!dryRun) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }

  // Final report
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('=== Results ===');
  console.log(`  Total records in CSV:    ${records.length}`);
  console.log(`  Processed:               ${processed}`);
  console.log(`  Updated:                 ${updated}`);
  console.log(`  Skipped (no mapping):    ${skippedNoMapping}`);
  console.log(`  Skipped (already set):   ${skippedAlreadySet}`);
  console.log(`  Skipped (not found):     ${skippedNotFound}`);
  console.log(`  Errors:                  ${errors}`);
  console.log(`  Time: ${totalTime}s`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
