/**
 * HIPAA Audit Data Export
 * ========================
 *
 * Date: 2025-02-10
 * Author: Kevin Park (kpark@meridianhealth.io)
 * Ticket: COMP-892 (https://meridian.atlassian.net/browse/COMP-892)
 *
 * Exports data for the annual HIPAA compliance audit by Thompson & Associates.
 * The auditors requested access logs, patient data access records, and
 * security incident reports for the period 2024-01-01 through 2024-12-31.
 *
 * Output is written to encrypted CSV files using AES-256-GCM encryption.
 * The encryption key is derived from the passphrase stored in AWS Secrets Manager
 * (secret: meridian/audit/export-key-2025).
 *
 * Files generated:
 *   - access_logs_2024.csv.enc         - All PHI access events
 *   - user_activity_2024.csv.enc       - User login/logout activity
 *   - security_incidents_2024.csv.enc  - Security incident records
 *   - patient_consent_2024.csv.enc     - Patient consent records
 *   - data_sharing_2024.csv.enc        - Third-party data sharing events
 *
 * IMPORTANT: These files contain PHI. Handle according to Meridian's
 * Data Handling Policy (POL-007). Files must be transmitted to the auditor
 * via the secure file exchange portal, NOT email.
 *
 * RUN:
 *   npx tsx scripts/one-off/export-for-audit.ts --output-dir /secure/audit-export-2025
 */

import { Pool } from 'pg';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';

const pipelineAsync = promisify(pipeline);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 300000,  // 5 min - some of these queries are big
});

// Audit period
const PERIOD_START = '2024-01-01T00:00:00Z';
const PERIOD_END = '2025-01-01T00:00:00Z';

// Parse args
const args = process.argv.slice(2);
let outputDir = '/tmp/meridian-audit-export';
let encryptionPassphrase = process.env.AUDIT_EXPORT_PASSPHRASE || '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output-dir') outputDir = args[++i];
  if (args[i] === '--passphrase') encryptionPassphrase = args[++i];
}

if (!encryptionPassphrase) {
  console.error('ERROR: AUDIT_EXPORT_PASSPHRASE environment variable is required');
  console.error('Get it from AWS Secrets Manager: meridian/audit/export-key-2025');
  process.exit(1);
}

// -- Encryption helpers ------------------------------------------------------

function createEncryptedWriter(filePath: string): {
  write: (data: string) => void;
  finish: () => Promise<void>;
} {
  const iv = randomBytes(16);
  const key = scryptSync(encryptionPassphrase, 'meridian-audit-salt', 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const outputStream = createWriteStream(filePath);

  // Write the IV as the first 16 bytes of the file
  outputStream.write(iv);

  return {
    write: (data: string) => {
      const encrypted = cipher.update(data, 'utf8');
      outputStream.write(encrypted);
    },
    finish: () => new Promise((resolve, reject) => {
      const final = cipher.final();
      outputStream.write(final);

      // Write the auth tag at the end (16 bytes)
      const authTag = cipher.getAuthTag();
      outputStream.write(authTag);

      outputStream.end(() => resolve());
      outputStream.on('error', reject);
    }),
  };
}

// -- Export functions ---------------------------------------------------------

async function exportAccessLogs(): Promise<number> {
  console.log('Exporting PHI access logs...');

  const writer = createEncryptedWriter(`${outputDir}/access_logs_2024.csv.enc`);
  writer.write('timestamp,user_id,user_email,user_role,action,resource_type,resource_id,patient_id,patient_mrn,ip_address,user_agent,result\n');

  let count = 0;
  const batchSize = 5000;
  let offset = 0;

  while (true) {
    const result = await pool.query(`
      SELECT
        al.created_at as timestamp,
        al.user_id,
        u.email as user_email,
        u.role as user_role,
        al.action,
        al.resource_type,
        al.resource_id,
        al.patient_id,
        p.mrn as patient_mrn,
        al.ip_address,
        al.user_agent,
        al.result
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      LEFT JOIN patients p ON p.id = al.patient_id
      WHERE al.created_at >= $1
        AND al.created_at < $2
        AND al.resource_type IN ('patient', 'encounter', 'medication', 'lab_result', 'document', 'claim')
      ORDER BY al.created_at
      LIMIT $3 OFFSET $4
    `, [PERIOD_START, PERIOD_END, batchSize, offset]);

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      // Escape CSV fields (basic - should use a proper CSV library but this is a one-off)
      const fields = [
        row.timestamp?.toISOString() || '',
        row.user_id || '',
        row.user_email || '',
        row.user_role || '',
        row.action || '',
        row.resource_type || '',
        row.resource_id || '',
        row.patient_id || '',
        row.patient_mrn || '',
        row.ip_address || '',
        `"${(row.user_agent || '').replace(/"/g, '""')}"`,
        row.result || '',
      ];
      writer.write(fields.join(',') + '\n');
      count++;
    }

    offset += batchSize;

    if (count % 50000 === 0) {
      console.log(`  ... ${count} records exported`);
    }
  }

  await writer.finish();
  console.log(`  Exported ${count} access log records`);
  return count;
}

async function exportUserActivity(): Promise<number> {
  console.log('Exporting user activity...');

  const writer = createEncryptedWriter(`${outputDir}/user_activity_2024.csv.enc`);
  writer.write('timestamp,user_id,user_email,user_role,event_type,ip_address,session_duration_minutes,mfa_used\n');

  const result = await pool.query(`
    SELECT
      ua.created_at as timestamp,
      ua.user_id,
      u.email as user_email,
      u.role as user_role,
      ua.event_type,
      ua.ip_address,
      EXTRACT(EPOCH FROM (ua.session_end - ua.session_start)) / 60 as session_duration_minutes,
      ua.mfa_used
    FROM user_activity ua
    JOIN users u ON u.id = ua.user_id
    WHERE ua.created_at >= $1
      AND ua.created_at < $2
    ORDER BY ua.created_at
  `, [PERIOD_START, PERIOD_END]);

  for (const row of result.rows) {
    writer.write([
      row.timestamp?.toISOString() || '',
      row.user_id || '',
      row.user_email || '',
      row.user_role || '',
      row.event_type || '',
      row.ip_address || '',
      row.session_duration_minutes?.toFixed(1) || '',
      row.mfa_used ? 'yes' : 'no',
    ].join(',') + '\n');
  }

  await writer.finish();
  console.log(`  Exported ${result.rows.length} user activity records`);
  return result.rows.length;
}

async function exportSecurityIncidents(): Promise<number> {
  console.log('Exporting security incidents...');

  const writer = createEncryptedWriter(`${outputDir}/security_incidents_2024.csv.enc`);
  writer.write('incident_id,reported_at,severity,category,description,affected_patients_count,resolution,resolved_at,reported_by\n');

  const result = await pool.query(`
    SELECT * FROM security_incidents
    WHERE reported_at >= $1 AND reported_at < $2
    ORDER BY reported_at
  `, [PERIOD_START, PERIOD_END]);

  for (const row of result.rows) {
    writer.write([
      row.id,
      row.reported_at?.toISOString() || '',
      row.severity || '',
      row.category || '',
      `"${(row.description || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
      row.affected_patients_count || '0',
      `"${(row.resolution || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
      row.resolved_at?.toISOString() || '',
      row.reported_by || '',
    ].join(',') + '\n');
  }

  await writer.finish();
  console.log(`  Exported ${result.rows.length} security incident records`);
  return result.rows.length;
}

async function exportPatientConsents(): Promise<number> {
  console.log('Exporting patient consents...');

  const writer = createEncryptedWriter(`${outputDir}/patient_consent_2024.csv.enc`);
  writer.write('consent_id,patient_id,patient_mrn,consent_type,status,granted_at,revoked_at,consent_document_id\n');

  const result = await pool.query(`
    SELECT
      pc.id,
      pc.patient_id,
      p.mrn,
      pc.consent_type,
      pc.status,
      pc.granted_at,
      pc.revoked_at,
      pc.consent_document_id
    FROM patient_consents pc
    JOIN patients p ON p.id = pc.patient_id
    WHERE pc.granted_at >= $1 AND pc.granted_at < $2
       OR pc.revoked_at >= $1 AND pc.revoked_at < $2
    ORDER BY pc.granted_at
  `, [PERIOD_START, PERIOD_END]);

  for (const row of result.rows) {
    writer.write([
      row.id,
      row.patient_id,
      row.mrn || '',
      row.consent_type || '',
      row.status || '',
      row.granted_at?.toISOString() || '',
      row.revoked_at?.toISOString() || '',
      row.consent_document_id || '',
    ].join(',') + '\n');
  }

  await writer.finish();
  console.log(`  Exported ${result.rows.length} patient consent records`);
  return result.rows.length;
}

async function exportDataSharing(): Promise<number> {
  console.log('Exporting data sharing events...');

  const writer = createEncryptedWriter(`${outputDir}/data_sharing_2024.csv.enc`);
  writer.write('event_id,timestamp,direction,partner_name,partner_type,data_type,patient_count,record_count,protocol,status\n');

  const result = await pool.query(`
    SELECT * FROM data_sharing_log
    WHERE created_at >= $1 AND created_at < $2
    ORDER BY created_at
  `, [PERIOD_START, PERIOD_END]);

  for (const row of result.rows) {
    writer.write([
      row.id,
      row.created_at?.toISOString() || '',
      row.direction || '',
      `"${row.partner_name || ''}"`,
      row.partner_type || '',
      row.data_type || '',
      row.patient_count || '0',
      row.record_count || '0',
      row.protocol || '',
      row.status || '',
    ].join(',') + '\n');
  }

  await writer.finish();
  console.log(`  Exported ${result.rows.length} data sharing events`);
  return result.rows.length;
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== HIPAA Audit Data Export ===');
  console.log(`Audit period: ${PERIOD_START} to ${PERIOD_END}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Encryption: AES-256-GCM`);
  console.log('');

  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const totals: Record<string, number> = {};

  try {
    totals.accessLogs = await exportAccessLogs();
    totals.userActivity = await exportUserActivity();
    totals.securityIncidents = await exportSecurityIncidents();
    totals.patientConsents = await exportPatientConsents();
    totals.dataSharing = await exportDataSharing();
  } catch (err) {
    console.error('Export failed:', err);
    process.exit(1);
  }

  console.log('');
  console.log('=== Export Complete ===');
  console.log('Files:');
  console.log(`  access_logs_2024.csv.enc         ${totals.accessLogs} records`);
  console.log(`  user_activity_2024.csv.enc       ${totals.userActivity} records`);
  console.log(`  security_incidents_2024.csv.enc  ${totals.securityIncidents} records`);
  console.log(`  patient_consent_2024.csv.enc     ${totals.patientConsents} records`);
  console.log(`  data_sharing_2024.csv.enc        ${totals.dataSharing} records`);
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Verify file sizes look reasonable');
  console.log('  2. Upload to secure exchange: https://secure.meridianhealth.io/audit-exchange');
  console.log('  3. Notify Thompson & Associates contact: audit@thompsonassoc.com');
  console.log('  4. Delete local files after confirmed receipt');
  console.log('  5. Log this export in the compliance tracker');

  await pool.end();
}

main();
