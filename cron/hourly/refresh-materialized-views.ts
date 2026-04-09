/**
 * Refresh Materialized Views
 *
 * Refreshes materialized views in the analytics database that power
 * dashboards and reports. Uses CONCURRENTLY to avoid locking read queries.
 *
 * Schedule: 30 * * * * (30 minutes past every hour)
 * Timeout: 20 minutes
 * Owner: Data Engineering (James Liu)
 */

import { CronJob } from '../lib/cron-job';
import { AnalyticsDatabase } from '../lib/analytics-db';
import { SlackNotifier } from '../lib/slack';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';

interface ViewRefreshResult {
  name: string;
  duration: number;
  rowCount: number;
  status: 'success' | 'error' | 'timeout';
  error?: string;
}

// Views ordered by priority and dependency
const MATERIALIZED_VIEWS = [
  {
    name: 'mv_daily_appointment_stats',
    description: 'Daily appointment counts by provider, type, and status',
    timeout: 120000, // 2 minutes
    concurrent: true,
  },
  {
    name: 'mv_claims_aging_summary',
    description: 'Claims aging buckets (current, 30, 60, 90, 120+ days)',
    timeout: 180000, // 3 minutes
    concurrent: true,
  },
  {
    name: 'mv_revenue_by_payer',
    description: 'Revenue breakdown by payer, month, and service type',
    timeout: 300000, // 5 minutes
    concurrent: true,
  },
  {
    name: 'mv_patient_demographics',
    description: 'Aggregated patient demographics for population health',
    timeout: 120000,
    concurrent: true,
  },
  {
    name: 'mv_provider_productivity',
    description: 'Provider wRVU and encounter metrics',
    timeout: 180000,
    concurrent: true,
  },
  {
    name: 'mv_denial_trends',
    description: 'Claim denial rates by reason, payer, and CPT code',
    timeout: 180000,
    concurrent: true,
  },
  {
    name: 'mv_eligibility_verification_stats',
    description: 'Insurance verification success rates and coverage gaps',
    timeout: 120000,
    concurrent: true,
  },
];

const job = new CronJob({
  name: 'refresh-materialized-views',
  schedule: '30 * * * *',
  timezone: 'America/New_York',
  timeout: 20 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const db = new AnalyticsDatabase();
  const slack = new SlackNotifier('#data-engineering');
  const startTime = Date.now();

  const results: ViewRefreshResult[] = [];
  let hasErrors = false;

  logger.info(`Starting materialized view refresh (${MATERIALIZED_VIEWS.length} views)`);

  for (const view of MATERIALIZED_VIEWS) {
    const viewStart = Date.now();

    try {
      logger.info(`Refreshing ${view.name}...`);

      // Set statement timeout for this refresh
      await db.query(`SET LOCAL statement_timeout = '${view.timeout}ms'`);

      // REFRESH CONCURRENTLY requires a unique index on the view
      // and allows read queries to continue during refresh
      const refreshQuery = view.concurrent
        ? `REFRESH MATERIALIZED VIEW CONCURRENTLY ${view.name}`
        : `REFRESH MATERIALIZED VIEW ${view.name}`;

      await db.query(refreshQuery);

      // Get the row count of the refreshed view
      const countResult = await db.query(`SELECT COUNT(*) as count FROM ${view.name}`);
      const rowCount = parseInt(countResult.rows[0].count, 10);

      const duration = Date.now() - viewStart;

      results.push({
        name: view.name,
        duration,
        rowCount,
        status: 'success',
      });

      metrics.timing(`cron.mv_refresh.${view.name}.duration`, duration);
      metrics.gauge(`cron.mv_refresh.${view.name}.row_count`, rowCount);

      logger.info(`Refreshed ${view.name} in ${Math.round(duration / 1000)}s (${rowCount} rows)`);

    } catch (error) {
      hasErrors = true;
      const duration = Date.now() - viewStart;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it was a timeout
      const isTimeout = errorMessage.includes('statement timeout') ||
                        errorMessage.includes('canceling statement');

      results.push({
        name: view.name,
        duration,
        rowCount: 0,
        status: isTimeout ? 'timeout' : 'error',
        error: errorMessage,
      });

      logger.error(`Failed to refresh ${view.name}: ${errorMessage}`);

      metrics.increment('cron.mv_refresh.errors', { view: view.name });

      // Continue with other views even if one fails
    }
  }

  // Summary
  const totalDuration = Date.now() - startTime;
  const successful = results.filter(r => r.status === 'success');
  const failed = results.filter(r => r.status !== 'success');

  metrics.timing('cron.mv_refresh.total_duration', totalDuration);
  metrics.gauge('cron.mv_refresh.views_refreshed', successful.length);
  metrics.gauge('cron.mv_refresh.views_failed', failed.length);

  logger.info(
    `Materialized view refresh complete: ${successful.length}/${results.length} succeeded in ${Math.round(totalDuration / 1000)}s`
  );

  // Alert on failures
  if (hasErrors) {
    let message = `*Materialized View Refresh Errors*\n`;
    for (const result of failed) {
      message += `- \`${result.name}\`: ${result.status} - ${result.error}\n`;
    }
    await slack.send(message);
  }

  await db.end();
});

export default job;
