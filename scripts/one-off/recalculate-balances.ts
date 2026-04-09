/**
 * Recalculate Patient Account Balances
 * ======================================
 *
 * Date: 2025-09-22
 * Author: Sarah Chen (schen@meridianhealth.io)
 * Incident: INC-3445 (https://meridian.atlassian.net/browse/INC-3445)
 *
 * WHAT HAPPENED:
 * A bug in the billing-engine (v2.7.0-v2.7.3, deployed 2025-09-15 to
 * 2025-09-21) caused payment postings to not update the patient's
 * account_balance field in the patients table. The payments were recorded
 * correctly in billing_transactions, but the denormalized balance on the
 * patient record wasn't updated.
 *
 * This means some patients show a balance that's higher than their actual
 * balance, which triggers incorrect collection letters and angry phone calls.
 * The fix for the bug was in PR #3892 (billing-engine v2.7.4).
 *
 * THIS SCRIPT:
 * Recalculates account_balance for ALL patients by summing their billing
 * transactions. We do all patients (not just those affected during the bug
 * window) because we want to correct any accumulated drift.
 *
 * We could have limited to patients with transactions between 9/15-9/21 but
 * honestly the balance field has been slightly off for a while. There was a
 * previous bug (INC-2067) that had a similar issue with claim adjustments.
 * This is a good opportunity to fix everything.
 *
 * RUN:
 *   DRY_RUN=true npx tsx scripts/one-off/recalculate-balances.ts
 *   npx tsx scripts/one-off/recalculate-balances.ts
 *   npx tsx scripts/one-off/recalculate-balances.ts --patient-id <uuid>  # single patient
 */

import { Pool } from 'pg';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 300000,
});

// Parse args
const singlePatientId = process.argv.includes('--patient-id')
  ? process.argv[process.argv.indexOf('--patient-id') + 1]
  : null;

interface BalanceDiscrepancy {
  patientId: string;
  mrn: string;
  patientName: string;
  currentBalance: number;
  calculatedBalance: number;
  difference: number;
}

async function calculateCorrectBalance(patientId: string): Promise<number> {
  // The correct balance is:
  //   SUM(charges) - SUM(payments) - SUM(adjustments) - SUM(insurance_payments)
  //
  // Or more precisely:
  //   SUM(amount) for all billing_transactions where the amount sign
  //   already accounts for type (charges are positive, payments/adjustments negative)
  //
  // NOTE(schen): I originally tried to do this with a single query joining
  // multiple tables but the billing schema is... complicated. The
  // billing_transactions table is the single source of truth for account
  // balance because it captures everything.

  const result = await pool.query(`
    SELECT COALESCE(SUM(
      CASE
        WHEN transaction_type IN ('charge', 'late_fee', 'interest') THEN amount
        WHEN transaction_type IN ('payment', 'insurance_payment', 'adjustment', 'write_off', 'refund') THEN -amount
        ELSE 0  -- shouldn't happen but defensive
      END
    ), 0) as calculated_balance
    FROM billing_transactions
    WHERE patient_id = $1
      AND status != 'voided'  -- voided transactions don't count
  `, [patientId]);

  // Round to cents
  return Math.round(parseFloat(result.rows[0].calculated_balance) * 100) / 100;
}

async function main(): Promise<void> {
  console.log('=== Recalculate Patient Account Balances ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : '*** LIVE ***'}`);
  console.log(`Time: ${new Date().toISOString()}`);
  if (singlePatientId) {
    console.log(`Patient: ${singlePatientId}`);
  }
  console.log('');

  const client = await pool.connect();

  try {
    // Get patients to process
    let patients: Array<{ id: string; mrn: string; name: string; currentBalance: number }>;

    if (singlePatientId) {
      const result = await client.query(
        `SELECT id, mrn, first_name || ' ' || last_name as name, account_balance
         FROM patients WHERE id = $1`,
        [singlePatientId]
      );
      patients = result.rows.map(r => ({
        id: r.id, mrn: r.mrn, name: r.name, currentBalance: parseFloat(r.account_balance || '0'),
      }));
    } else {
      // All active patients with any billing activity
      const result = await client.query(`
        SELECT DISTINCT p.id, p.mrn, p.first_name || ' ' || p.last_name as name, p.account_balance
        FROM patients p
        WHERE p.is_active = true
          AND (
            p.account_balance IS NOT NULL AND p.account_balance != 0
            OR EXISTS (SELECT 1 FROM billing_transactions bt WHERE bt.patient_id = p.id)
          )
        ORDER BY p.mrn
      `);
      patients = result.rows.map(r => ({
        id: r.id, mrn: r.mrn, name: r.name, currentBalance: parseFloat(r.account_balance || '0'),
      }));
    }

    console.log(`Processing ${patients.length} patients...`);
    console.log('');

    const discrepancies: BalanceDiscrepancy[] = [];
    let processed = 0;
    let unchanged = 0;
    let updated = 0;
    const startTime = Date.now();

    if (!DRY_RUN) {
      await client.query('BEGIN');
    }

    for (const patient of patients) {
      processed++;

      if (processed % 1000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(processed / parseFloat(elapsed));
        console.log(`  Progress: ${processed}/${patients.length} (${rate}/s) - Discrepancies: ${discrepancies.length}`);
      }

      const calculatedBalance = await calculateCorrectBalance(patient.id);
      const difference = Math.round((patient.currentBalance - calculatedBalance) * 100) / 100;

      // Only care about differences greater than 1 cent (floating point noise)
      if (Math.abs(difference) > 0.01) {
        discrepancies.push({
          patientId: patient.id,
          mrn: patient.mrn,
          patientName: patient.name,
          currentBalance: patient.currentBalance,
          calculatedBalance,
          difference,
        });

        if (!DRY_RUN) {
          await client.query(
            `UPDATE patients SET account_balance = $1, updated_at = NOW() WHERE id = $2`,
            [calculatedBalance, patient.id]
          );

          // Log the correction for audit trail
          await client.query(`
            INSERT INTO billing_transactions (
              id, patient_id, transaction_type, amount, description,
              reference_type, reference_id, status, created_at
            ) VALUES (
              gen_random_uuid(), $1, 'adjustment', $2,
              'Balance correction - INC-3445 recalculation script',
              'data_fix', 'INC-3445', 'completed', NOW()
            )
          `, [patient.id, -difference]);  // negative difference to correct the balance
        }

        updated++;
      } else {
        unchanged++;
      }
    }

    if (!DRY_RUN) {
      await client.query('COMMIT');
    }

    // Print results
    console.log('');
    console.log('=== Results ===');
    console.log(`  Patients processed:  ${processed}`);
    console.log(`  Balances correct:    ${unchanged}`);
    console.log(`  Balances corrected:  ${updated}`);
    console.log('');

    if (discrepancies.length > 0) {
      // Summary statistics
      const overcharged = discrepancies.filter(d => d.difference > 0);
      const undercharged = discrepancies.filter(d => d.difference < 0);
      const totalOvercharge = overcharged.reduce((sum, d) => sum + d.difference, 0);
      const totalUndercharge = undercharged.reduce((sum, d) => sum + Math.abs(d.difference), 0);

      console.log('  Discrepancy Summary:');
      console.log(`    Patients showing too HIGH a balance: ${overcharged.length} (total: $${totalOvercharge.toFixed(2)})`);
      console.log(`    Patients showing too LOW a balance:  ${undercharged.length} (total: $${totalUndercharge.toFixed(2)})`);
      console.log('');

      // Show largest discrepancies
      const sorted = [...discrepancies].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
      console.log('  Largest discrepancies:');
      for (const d of sorted.slice(0, 20)) {
        const direction = d.difference > 0 ? 'OVER' : 'UNDER';
        console.log(
          `    ${d.mrn.padEnd(15)} ${d.patientName.padEnd(30)} ` +
          `Current: $${d.currentBalance.toFixed(2).padStart(10)} ` +
          `Correct: $${d.calculatedBalance.toFixed(2).padStart(10)} ` +
          `Diff: $${Math.abs(d.difference).toFixed(2).padStart(8)} ${direction}`
        );
      }
    }

    console.log('');
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN - No changes applied' : 'LIVE - Changes committed'}`);
    console.log('');

    if (!DRY_RUN && discrepancies.length > 0) {
      console.log('POST-FIX STEPS:');
      console.log('  1. Verify balances in the billing UI for the largest discrepancies');
      console.log('  2. Hold any collection letters for 48 hours while we verify');
      console.log('  3. Send corrected statements to patients who were overcharged > $50');
      console.log('  4. Update INC-3445 with these results');
    }

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
