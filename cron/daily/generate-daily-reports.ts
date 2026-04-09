/**
 * Generate Daily Operational Reports
 *
 * Generates and emails daily summary reports to management.
 * Includes appointment stats, claims stats, revenue numbers,
 * and operational health metrics.
 *
 * Schedule: 0 7 * * 1-5 (7 AM ET, weekdays)
 * Timeout: 15 minutes
 * Owner: Analytics Team (James Liu)
 */

import { CronJob } from '../lib/cron-job';
import { AnalyticsDatabase } from '../lib/analytics-db';
import { EmailService } from '../lib/email';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';

const MANAGEMENT_DL = 'management-reports@meridianhealth.io';
const BILLING_DL = 'billing-leadership@meridianhealth.io';

const job = new CronJob({
  name: 'generate-daily-reports',
  schedule: '0 7 * * 1-5',
  timezone: 'America/New_York',
  timeout: 15 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const analytics = new AnalyticsDatabase();
  const email = new EmailService();
  const startTime = Date.now();

  // Report on the previous business day
  const reportDate = subDays(new Date(), 1);
  const dateStart = startOfDay(reportDate);
  const dateEnd = endOfDay(reportDate);
  const dateStr = format(reportDate, 'yyyy-MM-dd');

  logger.info(`Generating daily reports for ${dateStr}`);

  try {
    // 1. Appointment Statistics
    const appointmentStats = await analytics.query(`
      SELECT
        COUNT(*) as total_appointments,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE status = 'no_show') as no_shows,
        COUNT(*) FILTER (WHERE is_telehealth = true) as telehealth,
        COUNT(*) FILTER (WHERE appointment_type = 'NEW') as new_patients,
        ROUND(AVG(EXTRACT(EPOCH FROM (check_in_time - start_time)) / 60), 1) as avg_wait_minutes,
        COUNT(DISTINCT provider_id) as providers_with_appointments
      FROM appointments
      WHERE start_time BETWEEN $1 AND $2
    `, [dateStart, dateEnd]);

    // 2. Claims Statistics
    const claimsStats = await analytics.query(`
      SELECT
        COUNT(*) as total_claims_created,
        COUNT(*) FILTER (WHERE status = 'submitted') as submitted,
        COUNT(*) FILTER (WHERE status = 'paid') as paid,
        COUNT(*) FILTER (WHERE status = 'denied') as denied,
        COALESCE(SUM(total_billed), 0) as total_billed,
        COALESCE(SUM(total_paid) FILTER (WHERE paid_at BETWEEN $1 AND $2), 0) as payments_received,
        ROUND(AVG(EXTRACT(EPOCH FROM (paid_at - submitted_at)) / 86400), 1) FILTER (WHERE status = 'paid') as avg_days_to_payment
      FROM claims
      WHERE created_at BETWEEN $1 AND $2
         OR paid_at BETWEEN $1 AND $2
    `, [dateStart, dateEnd]);

    // 3. Revenue Summary
    const revenueStats = await analytics.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type = 'payment'), 0) as total_payments,
        COALESCE(SUM(amount) FILTER (WHERE type = 'copay'), 0) as copay_collected,
        COALESCE(SUM(amount) FILTER (WHERE type = 'self_pay'), 0) as self_pay_collected,
        COALESCE(SUM(amount) FILTER (WHERE type = 'refund'), 0) as refunds,
        COUNT(*) FILTER (WHERE type = 'payment') as payment_count
      FROM financial_transactions
      WHERE transaction_date BETWEEN $1 AND $2
    `, [dateStart, dateEnd]);

    // 4. Patient Statistics
    const patientStats = await analytics.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at BETWEEN $1 AND $2) as new_patients_registered,
        (SELECT COUNT(*) FROM patients WHERE status = 'active') as total_active_patients,
        COUNT(DISTINCT patient_id) FILTER (WHERE appointment_date BETWEEN $1 AND $2) as patients_seen
      FROM (
        SELECT p.created_at, a.patient_id, a.start_time::date as appointment_date
        FROM patients p
        LEFT JOIN appointments a ON a.patient_id = p.id AND a.status = 'completed'
      ) sub
    `, [dateStart, dateEnd]);

    // 5. Operational Health
    const operationalStats = await analytics.query(`
      SELECT
        COUNT(*) FILTER (WHERE level = 'ERROR' AND timestamp BETWEEN $1 AND $2) as error_count,
        COUNT(DISTINCT service) FILTER (WHERE level = 'ERROR' AND timestamp BETWEEN $1 AND $2) as services_with_errors,
        (SELECT ROUND(AVG(response_time_ms), 0) FROM api_metrics WHERE timestamp BETWEEN $1 AND $2) as avg_api_response_ms,
        (SELECT ROUND(
          COUNT(*) FILTER (WHERE status_code < 500)::numeric /
          NULLIF(COUNT(*), 0) * 100, 2
        ) FROM api_metrics WHERE timestamp BETWEEN $1 AND $2) as api_success_rate
      FROM application_logs
    `, [dateStart, dateEnd]);

    // Build report data
    const reportData = {
      date: format(reportDate, 'MMMM d, yyyy (EEEE)'),
      appointments: appointmentStats.rows[0],
      claims: claimsStats.rows[0],
      revenue: revenueStats.rows[0],
      patients: patientStats.rows[0],
      operations: operationalStats.rows[0],
    };

    // Send management report
    await email.send({
      to: MANAGEMENT_DL,
      subject: `Daily Operations Report - ${format(reportDate, 'MM/dd/yyyy')}`,
      template: 'daily-ops-report',
      data: reportData,
    });

    // Send billing-specific report
    await email.send({
      to: BILLING_DL,
      subject: `Daily Revenue Report - ${format(reportDate, 'MM/dd/yyyy')}`,
      template: 'daily-revenue-report',
      data: {
        date: reportData.date,
        claims: reportData.claims,
        revenue: reportData.revenue,
      },
    });

    const duration = Math.round((Date.now() - startTime) / 1000);
    metrics.timing('cron.daily_reports.duration', Date.now() - startTime);

    logger.info(`Daily reports generated and emailed in ${duration}s`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to generate daily reports: ${errorMessage}`);
    throw error;
  } finally {
    await analytics.end();
  }
});

export default job;
