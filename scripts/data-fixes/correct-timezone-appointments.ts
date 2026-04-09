/**
 * Fix DST Timezone Bug in Appointments
 * ======================================
 *
 * Date: 2024-11-03
 * Author: Sarah Chen (schen@meridianhealth.io)
 * Incident: INC-2891 (https://meridian.atlassian.net/browse/INC-2891)
 *
 * WHAT HAPPENED:
 * On November 3, 2024 (fall-back DST), appointments created between
 * 01:00 and 02:59 EST were stored with the wrong timezone offset. The
 * scheduling service was converting times from the user's local timezone
 * to UTC, but the moment.js (yes, we still use moment.js in the scheduling
 * service, don't @ me) ambiguous time handling defaulted to the pre-DST
 * offset instead of post-DST.
 *
 * This means appointments that should have been stored as, say, 09:00 EST
 * (-05:00) were stored as 09:00 EDT (-04:00), making them effectively
 * one hour EARLY in UTC.
 *
 * AFFECTED RECORDS:
 * - Appointments created between 2024-11-03 05:00 UTC and 2024-11-03 07:59 UTC
 *   (the ambiguous window in US Eastern time)
 * - Only affects appointments at facilities in US Eastern timezone
 * - Approximately 340 appointments affected
 *
 * FIX:
 * Add 1 hour to the appointment_date for affected records.
 *
 * RUN:
 *   DRY_RUN=true npx tsx scripts/data-fixes/correct-timezone-appointments.ts
 *   npx tsx scripts/data-fixes/correct-timezone-appointments.ts
 */

import { Pool } from 'pg';

const DRY_RUN = process.env.DRY_RUN !== 'false';  // default to dry run for safety!

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Facilities in US Eastern timezone (pulled from the facilities table)
// Hardcoding these because the facilities table doesn't have timezone info
// (another thing we should fix someday)
const EASTERN_FACILITY_IDS = [
  'fac-001', 'fac-002', 'fac-003', 'fac-005', 'fac-007',
  'fac-008', 'fac-012', 'fac-015', 'fac-018', 'fac-019',
  'fac-021', 'fac-022', 'fac-025', 'fac-028',
];

// The bug window in UTC
const BUG_WINDOW_START = '2024-11-03T05:00:00Z';
const BUG_WINDOW_END = '2024-11-03T08:00:00Z';

async function main(): Promise<void> {
  console.log('=== Fix DST Timezone Bug in Appointments ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (set DRY_RUN=false to apply)' : '*** LIVE ***'}`);
  console.log('');

  const client = await pool.connect();

  try {
    // First, let's see what we're dealing with
    const previewResult = await client.query(`
      SELECT
        a.id,
        a.appointment_date,
        a.appointment_date + interval '1 hour' as corrected_date,
        a.patient_id,
        p.first_name || ' ' || p.last_name as patient_name,
        a.provider_id,
        a.facility_id,
        a.status,
        a.appointment_type
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      WHERE a.created_at >= $1
        AND a.created_at < $2
        AND a.facility_id = ANY($3)
      ORDER BY a.appointment_date
    `, [BUG_WINDOW_START, BUG_WINDOW_END, EASTERN_FACILITY_IDS]);

    console.log(`Found ${previewResult.rows.length} affected appointments`);
    console.log('');

    if (previewResult.rows.length === 0) {
      console.log('Nothing to fix!');
      return;
    }

    // Show a sample
    console.log('Sample of affected records (first 10):');
    console.log('-'.repeat(120));
    for (const row of previewResult.rows.slice(0, 10)) {
      console.log(
        `  ${row.id} | ${row.patient_name.padEnd(25)} | ` +
        `${new Date(row.appointment_date).toISOString()} -> ${new Date(row.corrected_date).toISOString()} | ` +
        `${row.status} | ${row.appointment_type}`
      );
    }
    if (previewResult.rows.length > 10) {
      console.log(`  ... and ${previewResult.rows.length - 10} more`);
    }
    console.log('');

    // Breakdown by status
    const statusBreakdown = await client.query(`
      SELECT status, count(*) as cnt
      FROM appointments
      WHERE created_at >= $1
        AND created_at < $2
        AND facility_id = ANY($3)
      GROUP BY status
      ORDER BY cnt DESC
    `, [BUG_WINDOW_START, BUG_WINDOW_END, EASTERN_FACILITY_IDS]);

    console.log('Breakdown by status:');
    for (const row of statusBreakdown.rows) {
      console.log(`  ${row.status}: ${row.cnt}`);
    }
    console.log('');

    if (DRY_RUN) {
      console.log('DRY RUN - No changes made.');
      console.log('Set DRY_RUN=false to apply the fix.');
      return;
    }

    // Apply the fix
    console.log('Applying fix...');

    await client.query('BEGIN');

    // Log what we're about to do (for the audit trail)
    await client.query(`
      INSERT INTO data_fix_log (
        script_name, description, affected_table, affected_count,
        query_criteria, executed_by, executed_at
      ) VALUES (
        'correct-timezone-appointments',
        'Fix DST bug INC-2891: add 1 hour to appointments created during ambiguous DST window',
        'appointments',
        $1,
        $2,
        'schen',
        NOW()
      )
    `, [
      previewResult.rows.length,
      JSON.stringify({
        bugWindowStart: BUG_WINDOW_START,
        bugWindowEnd: BUG_WINDOW_END,
        facilityIds: EASTERN_FACILITY_IDS,
      }),
    ]);

    // The actual fix - shift appointment times forward by 1 hour
    const updateResult = await client.query(`
      UPDATE appointments
      SET appointment_date = appointment_date + interval '1 hour',
          updated_at = NOW(),
          -- Add a note so we know this was modified by a script
          notes = COALESCE(notes, '') || E'\n[AUTO-FIX INC-2891: appointment time corrected +1h for DST bug]'
      WHERE created_at >= $1
        AND created_at < $2
        AND facility_id = ANY($3)
    `, [BUG_WINDOW_START, BUG_WINDOW_END, EASTERN_FACILITY_IDS]);

    console.log(`Updated ${updateResult.rowCount} appointments`);

    // Also update any associated reminders that were sent with wrong times
    // These are in the notification queue
    const reminderResult = await client.query(`
      UPDATE notification_queue
      SET scheduled_at = scheduled_at + interval '1 hour',
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{dst_fix_applied}',
            'true'
          ),
          updated_at = NOW()
      WHERE reference_type = 'appointment'
        AND reference_id IN (
          SELECT id FROM appointments
          WHERE created_at >= $1
            AND created_at < $2
            AND facility_id = ANY($3)
        )
        AND status = 'pending'
    `, [BUG_WINDOW_START, BUG_WINDOW_END, EASTERN_FACILITY_IDS]);

    console.log(`Updated ${reminderResult.rowCount} pending reminders`);

    await client.query('COMMIT');

    console.log('');
    console.log('Fix applied successfully!');
    console.log('');
    console.log('POST-FIX STEPS:');
    console.log('  1. Verify appointments look correct in the scheduling UI');
    console.log('  2. Notify affected patients if their appointment was today/tomorrow');
    console.log(`  3. Update INC-2891 with results: ${updateResult.rowCount} appointments fixed`);

  } catch (err) {
    console.error('ERROR:', err);
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
