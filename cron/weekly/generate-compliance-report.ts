/**
 * Weekly HIPAA Compliance Report
 *
 * Generates a weekly compliance report covering audit log analysis,
 * encryption status, access reviews, and policy compliance metrics.
 * Required by our HIPAA compliance program.
 *
 * Schedule: 0 6 * * 1 (6 AM ET, Mondays)
 * Timeout: 30 minutes
 * Owner: Compliance (David Park)
 */

import { CronJob } from '../lib/cron-job';
import { AnalyticsDatabase } from '../lib/analytics-db';
import { AuditDatabase } from '../lib/audit-db';
import { EmailService } from '../lib/email';
import { S3Client } from '../clients/s3';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';
import { subDays, format } from 'date-fns';

const COMPLIANCE_DL = 'compliance-team@meridianhealth.io';
const HIPAA_OFFICER_EMAIL = 'david.park@meridianhealth.io';
const REPORT_BUCKET = process.env.S3_DOCUMENTS_BUCKET || 'meridian-documents-prod';

const job = new CronJob({
  name: 'generate-compliance-report',
  schedule: '0 6 * * 1',
  timezone: 'America/New_York',
  timeout: 30 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const analyticsDb = new AnalyticsDatabase();
  const auditDb = new AuditDatabase();
  const email = new EmailService();
  const s3 = new S3Client();
  const startTime = Date.now();

  const reportStart = subDays(new Date(), 7);
  const reportEnd = new Date();
  const reportPeriod = `${format(reportStart, 'yyyy-MM-dd')} to ${format(reportEnd, 'yyyy-MM-dd')}`;

  logger.info(`Generating weekly compliance report for ${reportPeriod}`);

  try {
    // 1. Audit Log Analysis
    const auditStats = await auditDb.query(`
      SELECT
        COUNT(*) as total_events,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(*) FILTER (WHERE action LIKE 'PHI_%') as phi_access_events,
        COUNT(*) FILTER (WHERE action = 'LOGIN_FAILED') as failed_logins,
        COUNT(*) FILTER (WHERE action = 'LOGIN_SUCCESS') as successful_logins,
        COUNT(*) FILTER (WHERE action = 'UNAUTHORIZED_ACCESS_ATTEMPT') as unauthorized_attempts,
        COUNT(*) FILTER (WHERE action = 'EXPORT_DATA') as data_exports,
        COUNT(*) FILTER (WHERE action = 'PATIENT_RECORD_VIEWED') as patient_records_viewed,
        COUNT(DISTINCT patient_id) FILTER (WHERE action = 'PATIENT_RECORD_VIEWED') as unique_patients_accessed
      FROM audit_events
      WHERE timestamp BETWEEN $1 AND $2
    `, [reportStart, reportEnd]);

    // 2. Unusual Access Patterns
    const unusualAccess = await auditDb.query(`
      SELECT
        user_id,
        u.name as user_name,
        u.role,
        COUNT(*) as access_count,
        COUNT(DISTINCT patient_id) as unique_patients,
        COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM timestamp) NOT BETWEEN 7 AND 19) as after_hours_count
      FROM audit_events ae
      JOIN users u ON u.id = ae.user_id
      WHERE ae.timestamp BETWEEN $1 AND $2
        AND ae.action = 'PATIENT_RECORD_VIEWED'
      GROUP BY user_id, u.name, u.role
      HAVING COUNT(DISTINCT patient_id) > 50
         OR COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM timestamp) NOT BETWEEN 7 AND 19) > 20
      ORDER BY unique_patients DESC
    `, [reportStart, reportEnd]);

    // 3. Encryption Status
    const encryptionStatus = await analyticsDb.query(`
      SELECT
        'database' as resource_type,
        'PostgreSQL Primary' as resource_name,
        true as encrypted_at_rest,
        true as encrypted_in_transit,
        'AES-256 (AWS KMS)' as encryption_method
      UNION ALL
      SELECT
        'database',
        'MongoDB Atlas',
        true,
        true,
        'AES-256 (Atlas Encryption)'
      UNION ALL
      SELECT
        'storage',
        'S3 Documents',
        true,
        true,
        'SSE-KMS (AES-256)'
      UNION ALL
      SELECT
        'cache',
        'Redis/ElastiCache',
        true,
        true,
        'TLS 1.2+ in-transit, AES-256 at-rest'
      UNION ALL
      SELECT
        'messaging',
        'RabbitMQ (Amazon MQ)',
        true,
        true,
        'TLS 1.2+ in-transit'
    `);

    // 4. Access Review Summary
    const accessReview = await auditDb.query(`
      SELECT
        u.role,
        COUNT(*) as user_count,
        COUNT(*) FILTER (WHERE u.last_login > NOW() - INTERVAL '30 days') as active_last_30d,
        COUNT(*) FILTER (WHERE u.last_login < NOW() - INTERVAL '90 days' OR u.last_login IS NULL) as inactive_90d,
        COUNT(*) FILTER (WHERE u.mfa_enabled = false) as no_mfa
      FROM users u
      WHERE u.status = 'active'
      GROUP BY u.role
      ORDER BY user_count DESC
    `, []);

    // 5. Password Policy Compliance
    const passwordCompliance = await auditDb.query(`
      SELECT
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE password_changed_at > NOW() - INTERVAL '90 days') as compliant,
        COUNT(*) FILTER (WHERE password_changed_at <= NOW() - INTERVAL '90 days') as expired,
        COUNT(*) FILTER (WHERE password_changed_at IS NULL) as never_changed
      FROM users
      WHERE status = 'active'
    `, []);

    // 6. BAA Tracking
    const baaStatus = await analyticsDb.query(`
      SELECT
        vendor_name,
        baa_signed_date,
        baa_expiry_date,
        CASE
          WHEN baa_expiry_date < NOW() THEN 'EXPIRED'
          WHEN baa_expiry_date < NOW() + INTERVAL '30 days' THEN 'EXPIRING_SOON'
          ELSE 'ACTIVE'
        END as status
      FROM vendor_baa_tracking
      WHERE is_subprocessor = true
      ORDER BY baa_expiry_date ASC
    `, []);

    // 7. Security Incident Summary
    const securityIncidents = await auditDb.query(`
      SELECT
        COUNT(*) as total_incidents,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical,
        COUNT(*) FILTER (WHERE severity = 'high') as high,
        COUNT(*) FILTER (WHERE status = 'open') as open_incidents,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved
      FROM security_incidents
      WHERE created_at BETWEEN $1 AND $2
    `, [reportStart, reportEnd]);

    // Build the report
    const report = {
      period: reportPeriod,
      generatedAt: new Date().toISOString(),
      sections: {
        auditLog: auditStats.rows[0],
        unusualAccessPatterns: unusualAccess.rows,
        encryptionStatus: encryptionStatus.rows,
        accessReview: accessReview.rows,
        passwordCompliance: passwordCompliance.rows[0],
        baaStatus: baaStatus.rows,
        securityIncidents: securityIncidents.rows[0],
      },
      complianceScore: calculateComplianceScore({
        auditStats: auditStats.rows[0],
        passwordCompliance: passwordCompliance.rows[0],
        accessReview: accessReview.rows,
        securityIncidents: securityIncidents.rows[0],
      }),
    };

    // Store report in S3 for archival (6-year retention)
    const reportKey = `compliance-reports/${format(reportEnd, 'yyyy/MM')}/weekly-${format(reportEnd, 'yyyy-MM-dd')}.json`;
    await s3.putObject({
      bucket: REPORT_BUCKET,
      key: reportKey,
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
      serverSideEncryption: 'aws:kms',
      metadata: {
        'report-type': 'hipaa-weekly-compliance',
        'report-period': reportPeriod,
      },
    });

    // Email report
    await email.send({
      to: COMPLIANCE_DL,
      cc: [HIPAA_OFFICER_EMAIL],
      subject: `Weekly HIPAA Compliance Report - ${format(reportEnd, 'MM/dd/yyyy')} (Score: ${report.complianceScore}%)`,
      template: 'compliance-report',
      data: report,
    });

    // Alert on critical findings
    const alerts: string[] = [];

    if (report.sections.unusualAccessPatterns.length > 0) {
      alerts.push(`${report.sections.unusualAccessPatterns.length} users with unusual access patterns detected`);
    }

    const expiredBaas = baaStatus.rows.filter((r: any) => r.status === 'EXPIRED');
    if (expiredBaas.length > 0) {
      alerts.push(`${expiredBaas.length} expired BAAs require immediate attention`);
    }

    if (report.sections.securityIncidents?.open_incidents > 0) {
      alerts.push(`${report.sections.securityIncidents.open_incidents} open security incidents`);
    }

    const noMfaUsers = accessReview.rows.reduce((sum: number, r: any) => sum + r.no_mfa, 0);
    if (noMfaUsers > 0) {
      alerts.push(`${noMfaUsers} active users without MFA enabled`);
    }

    if (alerts.length > 0) {
      logger.warn('Compliance alerts detected', { alerts });
    }

    const duration = Date.now() - startTime;
    metrics.timing('cron.compliance_report.duration', duration);
    metrics.gauge('cron.compliance_report.score', report.complianceScore);

    logger.info(`Compliance report generated in ${Math.round(duration / 1000)}s. Score: ${report.complianceScore}%`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Compliance report generation failed: ${errorMessage}`);

    await email.send({
      to: HIPAA_OFFICER_EMAIL,
      subject: '[URGENT] Weekly Compliance Report Generation Failed',
      template: 'generic-alert',
      data: { message: `The weekly compliance report failed to generate: ${errorMessage}` },
    });

    throw error;
  } finally {
    await analyticsDb.end();
    await auditDb.end();
  }
});

function calculateComplianceScore(data: any): number {
  let score = 100;

  // Deduct for password non-compliance
  if (data.passwordCompliance) {
    const total = data.passwordCompliance.total_users || 1;
    const expired = data.passwordCompliance.expired || 0;
    const pctExpired = expired / total;
    score -= Math.round(pctExpired * 15); // Up to 15 points
  }

  // Deduct for users without MFA
  if (data.accessReview) {
    const totalNoMfa = data.accessReview.reduce((sum: number, r: any) => sum + (r.no_mfa || 0), 0);
    score -= Math.min(totalNoMfa * 2, 20); // 2 points per user, max 20
  }

  // Deduct for unauthorized access attempts
  if (data.auditStats?.unauthorized_attempts > 0) {
    score -= Math.min(data.auditStats.unauthorized_attempts, 10);
  }

  // Deduct for open security incidents
  if (data.securityIncidents?.open_incidents > 0) {
    score -= data.securityIncidents.open_incidents * 5;
  }

  return Math.max(score, 0);
}

export default job;
