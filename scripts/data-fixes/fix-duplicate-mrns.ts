/**
 * FIX: Duplicate MRN Records in Production
 * ==========================================
 *
 * Date: 2024-08-15
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Incident: INC-2156 (https://meridian.atlassian.net/browse/INC-2156)
 * Approved by: Sarah Chen (schen), Kevin Park (kpark)
 *
 * BACKGROUND:
 * On 2024-08-13 at approximately 14:32 UTC, the patient registration service
 * experienced a race condition during high load (back-to-school physicals week)
 * that allowed duplicate MRN assignments. The bug was in the MRN generation
 * code path - we were checking for uniqueness, then generating the MRN, but
 * another request could slip in between the check and the insert.
 *
 * The fix (PR #2847) added a unique constraint at the database level and
 * switched to a SELECT ... FOR UPDATE pattern. This script cleans up the
 * 47 duplicate MRNs that were created before the fix went out.
 *
 * WHAT THIS SCRIPT DOES:
 * 1. Identifies all duplicate MRNs
 * 2. For each duplicate group, determines the "canonical" patient record
 *    (the one with the most activity: appointments, claims, etc.)
 * 3. Re-assigns all references from the duplicate to the canonical record
 * 4. Marks the duplicate patient as merged (soft delete with merge pointer)
 * 5. Generates a new unique MRN for the canonical record if needed
 *
 * ROLLBACK PLAN:
 * All changes are logged to the merge_audit table. To rollback:
 * 1. Query merge_audit for this script's run_id
 * 2. Reverse each operation in reverse order
 * 3. Or restore from the backup taken before running this script
 *
 * PRE-REQUISITES:
 * - Take a database backup: ./scripts/db/backup.sh --env production
 * - Verify backup: ./scripts/db/restore.sh --env staging --backup <latest>
 * - Get sign-off from compliance (HIPAA implications of merging records)
 *
 * RUN:
 *   DRY_RUN=true npx tsx scripts/data-fixes/fix-duplicate-mrns.ts
 *   npx tsx scripts/data-fixes/fix-duplicate-mrns.ts
 */

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';

const DRY_RUN = process.env.DRY_RUN === 'true';
const RUN_ID = randomUUID();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Use a longer timeout for this script - some of these queries touch big tables
  statement_timeout: 120000,  // 2 minutes
});

interface DuplicateGroup {
  mrn: string;
  patientIds: string[];
  patientDetails: Array<{
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    appointmentCount: number;
    claimCount: number;
    createdAt: Date;
  }>;
}

async function findDuplicateMRNs(client: PoolClient): Promise<DuplicateGroup[]> {
  console.log('Finding duplicate MRNs...');

  const result = await client.query(`
    SELECT mrn, array_agg(id ORDER BY created_at) as patient_ids
    FROM patients
    WHERE mrn IS NOT NULL
      AND is_active = true
      AND merged_into_id IS NULL
    GROUP BY mrn
    HAVING count(*) > 1
    ORDER BY mrn
  `);

  console.log(`Found ${result.rows.length} duplicate MRN groups`);

  const groups: DuplicateGroup[] = [];

  for (const row of result.rows) {
    const details = await client.query(`
      SELECT
        p.id,
        p.first_name,
        p.last_name,
        p.date_of_birth,
        p.created_at,
        (SELECT count(*) FROM appointments a WHERE a.patient_id = p.id) as appointment_count,
        (SELECT count(*) FROM claims c WHERE c.patient_id = p.id) as claim_count
      FROM patients p
      WHERE p.id = ANY($1)
      ORDER BY p.created_at
    `, [row.patient_ids]);

    groups.push({
      mrn: row.mrn,
      patientIds: row.patient_ids,
      patientDetails: details.rows.map(d => ({
        id: d.id,
        firstName: d.first_name,
        lastName: d.last_name,
        dateOfBirth: d.date_of_birth,
        appointmentCount: parseInt(d.appointment_count),
        claimCount: parseInt(d.claim_count),
        createdAt: d.created_at,
      })),
    });
  }

  return groups;
}

function selectCanonicalPatient(group: DuplicateGroup): string {
  // The canonical patient is the one with the most activity.
  // If tied, use the oldest record.
  const sorted = [...group.patientDetails].sort((a, b) => {
    const activityA = a.appointmentCount + a.claimCount;
    const activityB = b.appointmentCount + b.claimCount;
    if (activityA !== activityB) return activityB - activityA;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  return sorted[0].id;
}

async function mergePatient(
  client: PoolClient,
  canonicalId: string,
  duplicateId: string,
  mrn: string
): Promise<void> {
  console.log(`  Merging ${duplicateId} -> ${canonicalId}`);

  // Tables with patient_id foreign keys that need updating
  const TABLES_TO_UPDATE = [
    'appointments',
    'claims',
    'medications',
    'allergies',
    'lab_results',
    'documents',
    'eligibility_checks',
    'patient_encounters',
    'billing_transactions',
    'patient_notes',
    'referrals',
    'immunizations',
    // NOTE: we intentionally skip audit_log - we want to preserve the original
    // patient_id in audit records for traceability
  ];

  for (const table of TABLES_TO_UPDATE) {
    // Check how many rows would be affected
    const countResult = await client.query(
      `SELECT count(*) as cnt FROM ${table} WHERE patient_id = $1`,
      [duplicateId]
    );
    const count = parseInt(countResult.rows[0].cnt);

    if (count > 0) {
      console.log(`    ${table}: ${count} rows to update`);

      if (!DRY_RUN) {
        // Log the change for rollback
        await client.query(`
          INSERT INTO merge_audit (
            run_id, table_name, operation, canonical_id, duplicate_id,
            affected_count, executed_at
          ) VALUES ($1, $2, 'update_fk', $3, $4, $5, NOW())
        `, [RUN_ID, table, canonicalId, duplicateId, count]);

        // Do the actual update
        await client.query(
          `UPDATE ${table} SET patient_id = $1, updated_at = NOW() WHERE patient_id = $2`,
          [canonicalId, duplicateId]
        );
      }
    }
  }

  // Handle insurance info - take the most recent insurance from either record
  // This is a bit tricky because we don't want to lose insurance history
  // For now, we just keep the canonical patient's insurance and log the duplicate's
  if (!DRY_RUN) {
    // Save duplicate's insurance info to merge_audit for reference
    const dupeInsurance = await client.query(
      `SELECT insurance_payer, insurance_payer_id, insurance_member_id, insurance_group_number
       FROM patients WHERE id = $1`,
      [duplicateId]
    );

    await client.query(`
      INSERT INTO merge_audit (
        run_id, table_name, operation, canonical_id, duplicate_id,
        metadata, executed_at
      ) VALUES ($1, 'patients', 'insurance_backup', $2, $3, $4, NOW())
    `, [RUN_ID, canonicalId, duplicateId, JSON.stringify(dupeInsurance.rows[0])]);

    // Mark the duplicate as merged
    await client.query(`
      UPDATE patients
      SET is_active = false,
          merged_into_id = $1,
          merged_at = NOW(),
          merged_by = 'fix-duplicate-mrns-script',
          updated_at = NOW()
      WHERE id = $2
    `, [canonicalId, duplicateId]);
  }
}

async function main(): Promise<void> {
  console.log('==============================================');
  console.log('  Fix Duplicate MRNs');
  console.log(`  Run ID: ${RUN_ID}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : '*** LIVE ***'}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('==============================================');
  console.log('');

  const client = await pool.connect();

  try {
    // Start transaction
    await client.query('BEGIN');

    // Set a statement timeout for safety
    await client.query('SET statement_timeout = 120000');  // 2 min

    const duplicates = await findDuplicateMRNs(client);

    if (duplicates.length === 0) {
      console.log('No duplicate MRNs found. Nothing to do.');
      return;
    }

    console.log('');
    console.log(`Processing ${duplicates.length} duplicate groups...`);
    console.log('');

    let totalMerged = 0;

    for (const group of duplicates) {
      console.log(`MRN: ${group.mrn} (${group.patientIds.length} records)`);

      for (const detail of group.patientDetails) {
        console.log(`  - ${detail.id}: ${detail.firstName} ${detail.lastName}, DOB: ${detail.dateOfBirth}`);
        console.log(`    Appointments: ${detail.appointmentCount}, Claims: ${detail.claimCount}, Created: ${detail.createdAt.toISOString()}`);
      }

      const canonicalId = selectCanonicalPatient(group);
      const duplicateIds = group.patientIds.filter(id => id !== canonicalId);

      console.log(`  Canonical: ${canonicalId}`);
      console.log(`  Duplicates to merge: ${duplicateIds.join(', ')}`);

      for (const duplicateId of duplicateIds) {
        await mergePatient(client, canonicalId, duplicateId, group.mrn);
        totalMerged++;
      }

      console.log('');
    }

    if (DRY_RUN) {
      console.log('DRY RUN - Rolling back all changes');
      await client.query('ROLLBACK');
    } else {
      console.log(`Committing ${totalMerged} merges...`);
      await client.query('COMMIT');
      console.log('Committed!');
    }

    console.log('');
    console.log('==============================================');
    console.log(`  Complete! ${totalMerged} duplicate records merged.`);
    console.log(`  Run ID: ${RUN_ID}`);
    console.log('==============================================');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR: Script failed, transaction rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
