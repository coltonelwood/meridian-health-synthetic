/**
 * Merge Duplicate Patient Records
 * =================================
 *
 * Date: 2025-01-18
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Ticket: OPS-4521 (https://meridian.atlassian.net/browse/OPS-4521)
 *
 * PURPOSE:
 * General-purpose patient merge tool for the data ops team. Unlike
 * fix-duplicate-mrns.ts (which was a one-off for the MRN race condition),
 * this handles ongoing patient deduplication requests from the front desk
 * and HIM (Health Information Management) teams.
 *
 * Patients get duplicated for various reasons:
 * - Typos in name/DOB during registration
 * - Patient uses maiden name vs married name
 * - Insurance card has different name spelling
 * - Walk-in visits where staff doesn't search existing records
 *
 * This script merges one patient record into another, carefully handling
 * all foreign key references across the entire database.
 *
 * USAGE:
 *   # Merge patient B into patient A (A becomes the surviving record)
 *   npx tsx scripts/data-fixes/merge-duplicate-patients.ts \
 *     --canonical <patient-id-A> \
 *     --duplicate <patient-id-B> \
 *     [--dry-run] \
 *     [--reason "Duplicate registration - same DOB, SSN last 4"]
 *
 *   # Merge from a CSV of pre-approved merges
 *   npx tsx scripts/data-fixes/merge-duplicate-patients.ts \
 *     --file merges-approved-2025-01.csv \
 *     [--dry-run]
 *
 * ROLLBACK PLAN:
 * ===============
 * Every merge operation is fully logged in the patient_merge_log table with
 * enough detail to reverse it. Rollback procedure:
 *
 * 1. Find the merge_id:
 *    SELECT * FROM patient_merge_log WHERE canonical_id = '<id>' ORDER BY executed_at DESC;
 *
 * 2. For each row in patient_merge_detail WHERE merge_id = '<merge_id>':
 *    - If operation = 'reassign_fk':
 *      UPDATE <table_name> SET patient_id = <old_patient_id>
 *        WHERE id = ANY(<affected_record_ids>);
 *    - If operation = 'deactivate':
 *      UPDATE patients SET is_active = true, merged_into_id = NULL, merged_at = NULL
 *        WHERE id = <duplicate_id>;
 *
 * 3. Obviously, test this in staging first.
 *
 * 4. If it's been more than 24 hours, new records may have been created
 *    against the canonical ID, making rollback more complex. Talk to
 *    engineering in that case.
 *
 * IMPORTANT NOTES:
 * - Both patients must exist and be in the same organization
 * - The canonical (surviving) patient keeps their demographics
 * - If the duplicate has more recent insurance info, it's copied over
 * - Appointment conflicts (same time, same provider) are logged but not auto-resolved
 * - PHI access is logged per HIPAA requirements
 */

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

// -- CLI Parsing -------------------------------------------------------------

interface MergeRequest {
  canonicalId: string;
  duplicateId: string;
  reason: string;
}

const args = process.argv.slice(2);
let dryRun = false;
let requests: MergeRequest[] = [];
let operatorId = process.env.USER || 'unknown';

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--canonical': {
      const canonicalId = args[++i];
      // Find --duplicate
      const dupIdx = args.indexOf('--duplicate', i);
      if (dupIdx === -1) { console.error('--duplicate required with --canonical'); process.exit(1); }
      const duplicateId = args[dupIdx + 1];
      const reasonIdx = args.indexOf('--reason', i);
      const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : 'Manual merge';
      requests.push({ canonicalId, duplicateId, reason });
      break;
    }
    case '--file': {
      const csvContent = readFileSync(args[++i], 'utf-8');
      const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
      for (const row of rows) {
        requests.push({
          canonicalId: row.canonical_id || row.canonical_patient_id,
          duplicateId: row.duplicate_id || row.duplicate_patient_id,
          reason: row.reason || 'Batch merge from CSV',
        });
      }
      break;
    }
    case '--dry-run':
      dryRun = true;
      break;
    case '--operator':
      operatorId = args[++i];
      break;
    case '--duplicate':
    case '--reason':
      i++; // skip, handled above
      break;
  }
}

if (requests.length === 0) {
  console.error('No merge requests specified. Use --canonical/--duplicate or --file');
  process.exit(1);
}

// -- Database ----------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 60000,
});

// Every table that has a patient_id column. This list MUST be kept in sync
// with the schema. If you add a new table with patient_id, add it here!
// Last updated: 2025-01-18 by ajiang
const PATIENT_FK_TABLES = [
  { table: 'appointments', fk: 'patient_id' },
  { table: 'claims', fk: 'patient_id' },
  { table: 'claims_line_items', fk: 'patient_id' },
  { table: 'patient_encounters', fk: 'patient_id' },
  { table: 'medications', fk: 'patient_id' },
  { table: 'allergies', fk: 'patient_id' },
  { table: 'lab_results', fk: 'patient_id' },
  { table: 'lab_orders', fk: 'patient_id' },
  { table: 'documents', fk: 'patient_id' },
  { table: 'document_signatures', fk: 'patient_id' },
  { table: 'eligibility_checks', fk: 'patient_id' },
  { table: 'billing_transactions', fk: 'patient_id' },
  { table: 'patient_notes', fk: 'patient_id' },
  { table: 'referrals', fk: 'patient_id' },
  { table: 'referrals', fk: 'referred_patient_id' },  // referrals has TWO patient FKs
  { table: 'immunizations', fk: 'patient_id' },
  { table: 'care_plans', fk: 'patient_id' },
  { table: 'patient_consents', fk: 'patient_id' },
  { table: 'patient_portal_accounts', fk: 'patient_id' },
  { table: 'communication_preferences', fk: 'patient_id' },
  { table: 'insurance_history', fk: 'patient_id' },
  { table: 'notification_queue', fk: 'recipient_patient_id' },
  // NOTE: audit_log intentionally excluded - keep original patient_id for audit trail
  // NOTE: patient_merge_log intentionally excluded - would be recursive lol
];

async function validateMerge(
  client: PoolClient,
  req: MergeRequest
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Both patients must exist
  const canonical = await client.query(
    'SELECT id, mrn, first_name, last_name, date_of_birth, organization_id, is_active, merged_into_id FROM patients WHERE id = $1',
    [req.canonicalId]
  );
  const duplicate = await client.query(
    'SELECT id, mrn, first_name, last_name, date_of_birth, organization_id, is_active, merged_into_id FROM patients WHERE id = $1',
    [req.duplicateId]
  );

  if (canonical.rows.length === 0) {
    errors.push(`Canonical patient ${req.canonicalId} not found`);
  }
  if (duplicate.rows.length === 0) {
    errors.push(`Duplicate patient ${req.duplicateId} not found`);
  }

  if (errors.length > 0) return { valid: false, errors };

  const c = canonical.rows[0];
  const d = duplicate.rows[0];

  // Can't merge into self
  if (req.canonicalId === req.duplicateId) {
    errors.push('Cannot merge a patient into themselves');
  }

  // Must be in same organization
  if (c.organization_id !== d.organization_id) {
    errors.push(`Patients are in different organizations: ${c.organization_id} vs ${d.organization_id}`);
  }

  // Canonical should be active
  if (!c.is_active) {
    errors.push(`Canonical patient ${req.canonicalId} is not active`);
  }

  // Duplicate shouldn't already be merged
  if (d.merged_into_id) {
    errors.push(`Duplicate patient ${req.duplicateId} is already merged into ${d.merged_into_id}`);
  }

  // Canonical shouldn't already be merged into something
  if (c.merged_into_id) {
    errors.push(`Canonical patient ${req.canonicalId} is itself merged into ${c.merged_into_id}`);
  }

  return { valid: errors.length === 0, errors };
}

async function executeMerge(
  client: PoolClient,
  req: MergeRequest
): Promise<{ success: boolean; recordsMoved: number }> {
  const mergeId = randomUUID();
  let totalRecordsMoved = 0;

  // Log the merge header
  if (!dryRun) {
    await client.query(`
      INSERT INTO patient_merge_log (
        id, canonical_id, duplicate_id, reason, operator_id,
        is_dry_run, executed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [mergeId, req.canonicalId, req.duplicateId, req.reason, operatorId, dryRun]);
  }

  // Reassign all foreign key references
  for (const { table, fk } of PATIENT_FK_TABLES) {
    try {
      // Check if table exists (some tables might have been dropped)
      const tableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = $1
        )
      `, [table]);

      if (!tableExists.rows[0].exists) {
        console.log(`    Skipping ${table} (table doesn't exist)`);
        continue;
      }

      const countResult = await client.query(
        `SELECT count(*) as cnt FROM ${table} WHERE ${fk} = $1`,
        [req.duplicateId]
      );
      const count = parseInt(countResult.rows[0].cnt);

      if (count === 0) continue;

      console.log(`    ${table}.${fk}: ${count} records`);

      if (!dryRun) {
        // Get affected IDs for rollback logging
        const affectedIds = await client.query(
          `SELECT id FROM ${table} WHERE ${fk} = $1`,
          [req.duplicateId]
        );

        // Log the detail
        await client.query(`
          INSERT INTO patient_merge_detail (
            merge_id, table_name, column_name, operation,
            old_patient_id, new_patient_id, affected_record_ids, affected_count
          ) VALUES ($1, $2, $3, 'reassign_fk', $4, $5, $6, $7)
        `, [
          mergeId, table, fk, req.duplicateId, req.canonicalId,
          JSON.stringify(affectedIds.rows.map(r => r.id)),
          count,
        ]);

        // Do the update
        await client.query(
          `UPDATE ${table} SET ${fk} = $1, updated_at = NOW() WHERE ${fk} = $2`,
          [req.canonicalId, req.duplicateId]
        );
      }

      totalRecordsMoved += count;
    } catch (err) {
      // Some tables might not have updated_at column, retry without it
      const errMsg = (err as Error).message;
      if (errMsg.includes('updated_at')) {
        if (!dryRun) {
          await client.query(
            `UPDATE ${table} SET ${fk} = $1 WHERE ${fk} = $2`,
            [req.canonicalId, req.duplicateId]
          );
        }
      } else {
        throw err;
      }
    }
  }

  // Check for appointment conflicts
  const conflicts = await client.query(`
    SELECT a1.id as canonical_appt, a2.id as duplicate_appt,
           a1.appointment_date, a1.provider_id
    FROM appointments a1
    JOIN appointments a2 ON a1.provider_id = a2.provider_id
      AND a1.appointment_date = a2.appointment_date
    WHERE a1.patient_id = $1
      AND a2.patient_id = $1
      AND a1.id != a2.id
      AND a1.status != 'cancelled'
      AND a2.status != 'cancelled'
  `, [req.canonicalId]);

  if (conflicts.rows.length > 0) {
    console.log(`    WARNING: ${conflicts.rows.length} appointment time conflicts detected!`);
    console.log(`    These need manual review.`);
    // We don't auto-resolve these because we don't know which one the patient
    // actually intended to keep
  }

  // Copy insurance info from duplicate if it's more recent
  if (!dryRun) {
    await client.query(`
      UPDATE patients
      SET insurance_payer = COALESCE(
            (SELECT insurance_payer FROM patients WHERE id = $2 AND insurance_payer IS NOT NULL),
            insurance_payer
          ),
          insurance_payer_id = COALESCE(
            (SELECT insurance_payer_id FROM patients WHERE id = $2 AND insurance_payer_id IS NOT NULL),
            insurance_payer_id
          ),
          updated_at = NOW()
      WHERE id = $1
        AND (insurance_payer IS NULL OR insurance_payer_id IS NULL)
    `, [req.canonicalId, req.duplicateId]);
  }

  // Deactivate the duplicate
  if (!dryRun) {
    await client.query(`
      UPDATE patients
      SET is_active = false,
          merged_into_id = $1,
          merged_at = NOW(),
          merged_by = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [req.canonicalId, operatorId, req.duplicateId]);

    // Deactivate duplicate's portal account if they have one
    await client.query(`
      UPDATE patient_portal_accounts
      SET is_active = false,
          deactivation_reason = 'Patient record merged into ' || $1,
          updated_at = NOW()
      WHERE patient_id = $2
        AND is_active = true
    `, [req.canonicalId, req.duplicateId]);
  }

  return { success: true, recordsMoved: totalRecordsMoved };
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Patient Record Merge Tool ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : '*** LIVE ***'}`);
  console.log(`Operator: ${operatorId}`);
  console.log(`Merge requests: ${requests.length}`);
  console.log('');

  const client = await pool.connect();
  let successCount = 0;
  let failCount = 0;

  try {
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      console.log(`[${i + 1}/${requests.length}] Merging ${req.duplicateId} -> ${req.canonicalId}`);
      console.log(`  Reason: ${req.reason}`);

      await client.query('BEGIN');

      // Validate
      const validation = await validateMerge(client, req);
      if (!validation.valid) {
        console.log(`  SKIPPED - Validation failed:`);
        for (const err of validation.errors) {
          console.log(`    - ${err}`);
        }
        await client.query('ROLLBACK');
        failCount++;
        continue;
      }

      // Execute
      try {
        const result = await executeMerge(client, req);
        console.log(`  ${dryRun ? 'Would move' : 'Moved'} ${result.recordsMoved} records`);

        if (dryRun) {
          await client.query('ROLLBACK');
        } else {
          await client.query('COMMIT');
        }
        successCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ERROR: ${(err as Error).message}`);
        failCount++;
      }

      console.log('');
    }
  } finally {
    client.release();
  }

  console.log('=== Summary ===');
  console.log(`  Total requests: ${requests.length}`);
  console.log(`  Successful:     ${successCount}`);
  console.log(`  Failed:         ${failCount}`);
  console.log(`  Mode:           ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  await pool.end();

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
