/**
 * Claims Anomaly Detection
 *
 * Runs ML-based anomaly detection on recent claims to identify
 * suspicious patterns like upcoding, unbundling, duplicate billing,
 * and unusual claim volumes. Flagged claims are queued for human review.
 *
 * Schedule: 0 4 * * 0 (4 AM ET, Sundays)
 * Timeout: 60 minutes
 * Owner: Revenue Cycle / Compliance (James Liu)
 */

import { CronJob } from '../lib/cron-job';
import { AnalyticsDatabase } from '../lib/analytics-db';
import { ClaimsRepository } from '../repositories/claims';
import { SlackNotifier } from '../lib/slack';
import { EmailService } from '../lib/email';
import { AuditLogger } from '../lib/audit';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';
import { subDays, format } from 'date-fns';

interface AnomalyFlag {
  claimId: string;
  patientMrn: string;
  providerNpi: string;
  providerName: string;
  anomalyType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  score: number;
  description: string;
  relatedClaims?: string[];
}

const LOOKBACK_DAYS = 7;
const ANOMALY_THRESHOLD = 0.75; // Flag claims with anomaly score > 0.75

const job = new CronJob({
  name: 'run-anomaly-detection',
  schedule: '0 4 * * 0',
  timezone: 'America/New_York',
  timeout: 60 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const analyticsDb = new AnalyticsDatabase();
  const claimsRepo = new ClaimsRepository();
  const slack = new SlackNotifier('#compliance-alerts');
  const email = new EmailService();
  const audit = new AuditLogger('anomaly-detection');
  const startTime = Date.now();

  const lookbackStart = subDays(new Date(), LOOKBACK_DAYS);
  const lookbackEnd = new Date();

  const results = {
    claimsAnalyzed: 0,
    anomaliesDetected: 0,
    bySeverity: { low: 0, medium: 0, high: 0, critical: 0 },
    byType: {} as Record<string, number>,
    flags: [] as AnomalyFlag[],
  };

  logger.info(`Starting anomaly detection for claims from ${format(lookbackStart, 'yyyy-MM-dd')} to ${format(lookbackEnd, 'yyyy-MM-dd')}`);

  try {
    // 1. Check for potential upcoding
    // Compare E&M code distribution per provider against historical baselines
    const upcodingResults = await analyticsDb.query(`
      WITH provider_code_dist AS (
        SELECT
          c.rendering_provider_npi,
          p.name as provider_name,
          cl.cpt_code,
          COUNT(*) as code_count,
          COUNT(*)::numeric / SUM(COUNT(*)) OVER (PARTITION BY c.rendering_provider_npi) as pct
        FROM claims c
        JOIN claim_line_items cl ON cl.claim_id = c.id
        JOIN providers p ON p.npi = c.rendering_provider_npi
        WHERE c.service_date BETWEEN $1 AND $2
          AND cl.cpt_code IN ('99211','99212','99213','99214','99215')
        GROUP BY c.rendering_provider_npi, p.name, cl.cpt_code
      ),
      baseline AS (
        SELECT cpt_code, AVG(pct) as avg_pct, STDDEV(pct) as std_pct
        FROM provider_code_dist
        GROUP BY cpt_code
      )
      SELECT
        d.rendering_provider_npi,
        d.provider_name,
        d.cpt_code,
        d.code_count,
        d.pct,
        b.avg_pct,
        b.std_pct,
        CASE WHEN b.std_pct > 0 THEN (d.pct - b.avg_pct) / b.std_pct ELSE 0 END as z_score
      FROM provider_code_dist d
      JOIN baseline b ON b.cpt_code = d.cpt_code
      WHERE d.cpt_code IN ('99214', '99215')
        AND CASE WHEN b.std_pct > 0 THEN (d.pct - b.avg_pct) / b.std_pct ELSE 0 END > 2.0
      ORDER BY z_score DESC
    `, [lookbackStart, lookbackEnd]);

    for (const row of upcodingResults.rows) {
      const severity = row.z_score > 3.0 ? 'high' : 'medium';
      results.flags.push({
        claimId: 'multiple',
        patientMrn: 'multiple',
        providerNpi: row.rendering_provider_npi,
        providerName: row.provider_name,
        anomalyType: 'upcoding',
        severity,
        score: Math.min(row.z_score / 4, 1.0),
        description: `Provider ${row.provider_name} bills ${row.cpt_code} at ${(row.pct * 100).toFixed(1)}% ` +
                     `vs average ${(row.avg_pct * 100).toFixed(1)}% (z-score: ${row.z_score.toFixed(2)})`,
      });
    }

    // 2. Check for duplicate claims
    const duplicateResults = await analyticsDb.query(`
      SELECT
        c1.id as claim_id_1,
        c2.id as claim_id_2,
        c1.patient_mrn,
        c1.rendering_provider_npi,
        p.name as provider_name,
        c1.service_date,
        c1.total_billed
      FROM claims c1
      JOIN claims c2 ON c1.patient_id = c2.patient_id
        AND c1.service_date = c2.service_date
        AND c1.rendering_provider_npi = c2.rendering_provider_npi
        AND c1.id < c2.id
        AND c1.status NOT IN ('voided', 'denied')
        AND c2.status NOT IN ('voided', 'denied')
      JOIN providers p ON p.npi = c1.rendering_provider_npi
      WHERE c1.created_at BETWEEN $1 AND $2
    `, [lookbackStart, lookbackEnd]);

    for (const row of duplicateResults.rows) {
      results.flags.push({
        claimId: row.claim_id_1,
        patientMrn: row.patient_mrn,
        providerNpi: row.rendering_provider_npi,
        providerName: row.provider_name,
        anomalyType: 'duplicate_claim',
        severity: 'high',
        score: 0.95,
        description: `Potential duplicate claims ${row.claim_id_1} and ${row.claim_id_2} ` +
                     `for same patient/provider/date (${row.service_date}), billed $${row.total_billed}`,
        relatedClaims: [row.claim_id_2],
      });
    }

    // 3. Check for unbundling (billing components separately that should be a panel)
    const unbundlingResults = await analyticsDb.query(`
      WITH panel_components AS (
        -- CMP components that should be billed as 80053
        SELECT claim_id, COUNT(DISTINCT cpt_code) as component_count
        FROM claim_line_items
        WHERE claim_id IN (SELECT id FROM claims WHERE service_date BETWEEN $1 AND $2)
          AND cpt_code IN ('82310','82374','82435','82565','82947','84075','84460','84295','84132','84155','82040','82248')
        GROUP BY claim_id
        HAVING COUNT(DISTINCT cpt_code) >= 6
      )
      SELECT
        c.id as claim_id,
        c.patient_mrn,
        c.rendering_provider_npi,
        p.name as provider_name,
        pc.component_count,
        c.total_billed
      FROM panel_components pc
      JOIN claims c ON c.id = pc.claim_id
      JOIN providers p ON p.npi = c.rendering_provider_npi
      WHERE c.status NOT IN ('voided')
    `, [lookbackStart, lookbackEnd]);

    for (const row of unbundlingResults.rows) {
      results.flags.push({
        claimId: row.claim_id,
        patientMrn: row.patient_mrn,
        providerNpi: row.rendering_provider_npi,
        providerName: row.provider_name,
        anomalyType: 'unbundling',
        severity: 'medium',
        score: 0.80,
        description: `Claim ${row.claim_id} has ${row.component_count} individual lab components that may be a CMP panel (80053)`,
      });
    }

    // 4. Unusual volume detection per provider
    const volumeResults = await analyticsDb.query(`
      WITH weekly_volumes AS (
        SELECT
          rendering_provider_npi,
          COUNT(*) as claim_count,
          AVG(COUNT(*)) OVER (PARTITION BY rendering_provider_npi) as avg_count,
          STDDEV(COUNT(*)) OVER (PARTITION BY rendering_provider_npi) as std_count
        FROM claims
        WHERE service_date BETWEEN $1 AND $2
        GROUP BY rendering_provider_npi
      )
      SELECT
        v.rendering_provider_npi,
        p.name as provider_name,
        v.claim_count,
        v.avg_count,
        v.std_count,
        CASE WHEN v.std_count > 0 THEN (v.claim_count - v.avg_count) / v.std_count ELSE 0 END as z_score
      FROM weekly_volumes v
      JOIN providers p ON p.npi = v.rendering_provider_npi
      WHERE CASE WHEN v.std_count > 0 THEN (v.claim_count - v.avg_count) / v.std_count ELSE 0 END > 2.5
    `, [lookbackStart, lookbackEnd]);

    for (const row of volumeResults.rows) {
      results.flags.push({
        claimId: 'multiple',
        patientMrn: 'multiple',
        providerNpi: row.rendering_provider_npi,
        providerName: row.provider_name,
        anomalyType: 'unusual_volume',
        severity: row.z_score > 3.5 ? 'high' : 'low',
        score: Math.min(row.z_score / 4, 1.0),
        description: `Provider ${row.provider_name} submitted ${row.claim_count} claims this week ` +
                     `vs average ${Math.round(row.avg_count)} (z-score: ${row.z_score.toFixed(2)})`,
      });
    }

    // Summarize
    results.anomaliesDetected = results.flags.length;
    for (const flag of results.flags) {
      results.bySeverity[flag.severity]++;
      results.byType[flag.anomalyType] = (results.byType[flag.anomalyType] || 0) + 1;
    }

    // Queue flagged claims for review
    for (const flag of results.flags) {
      if (flag.score >= ANOMALY_THRESHOLD) {
        await claimsRepo.createReviewTask({
          claimId: flag.claimId,
          reviewType: 'anomaly_detection',
          anomalyType: flag.anomalyType,
          severity: flag.severity,
          score: flag.score,
          description: flag.description,
          relatedClaims: flag.relatedClaims,
          assignedTo: null, // Will be assigned by compliance team
          createdBy: 'cron:anomaly-detection',
        });

        await audit.log({
          action: 'ANOMALY_FLAGGED',
          resourceType: 'claim',
          resourceId: flag.claimId,
          details: {
            anomalyType: flag.anomalyType,
            severity: flag.severity,
            score: flag.score,
            providerNpi: flag.providerNpi,
          },
        });
      }
    }

    // Notify compliance team
    if (results.anomaliesDetected > 0) {
      const criticalAndHigh = results.flags.filter(f => f.severity === 'critical' || f.severity === 'high');

      await slack.send(
        `*Weekly Anomaly Detection Report*\n` +
        `Period: ${format(lookbackStart, 'MM/dd')} - ${format(lookbackEnd, 'MM/dd')}\n` +
        `Total anomalies: ${results.anomaliesDetected}\n` +
        `Critical: ${results.bySeverity.critical} | High: ${results.bySeverity.high} | ` +
        `Medium: ${results.bySeverity.medium} | Low: ${results.bySeverity.low}\n` +
        `Types: ${Object.entries(results.byType).map(([k, v]) => `${k}: ${v}`).join(', ')}\n` +
        `Review queue updated. ${criticalAndHigh.length} items require immediate attention.`
      );

      // Email detailed report to compliance
      await email.send({
        to: 'compliance-team@meridianhealth.io',
        subject: `[Compliance] Weekly Anomaly Report - ${results.anomaliesDetected} Findings`,
        template: 'anomaly-report',
        data: {
          period: `${format(lookbackStart, 'MM/dd/yyyy')} - ${format(lookbackEnd, 'MM/dd/yyyy')}`,
          results,
          flags: results.flags,
        },
      });
    }

    const duration = Date.now() - startTime;
    metrics.gauge('cron.anomaly_detection.total', results.anomaliesDetected);
    metrics.gauge('cron.anomaly_detection.high_severity', results.bySeverity.high + results.bySeverity.critical);
    metrics.timing('cron.anomaly_detection.duration', duration);

    logger.info(`Anomaly detection complete in ${Math.round(duration / 1000)}s`, results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Anomaly detection failed: ${errorMessage}`);
    await slack.sendUrgent(`Anomaly detection FAILED: ${errorMessage}`);
    throw error;
  } finally {
    await analyticsDb.end();
  }
});

export default job;
