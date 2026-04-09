/**
 * Cleanup Expired Sessions
 *
 * Removes expired JWT refresh tokens and invalidated sessions from
 * the database. Also cleans up stale FHIR bulk export files.
 *
 * Schedule: 0 3 * * * (3 AM ET daily)
 * Timeout: 10 minutes
 * Owner: Platform Team
 */

import { CronJob } from '../lib/cron-job';
import { DatabasePool } from '../lib/database';
import { S3Client } from '../clients/s3';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';

const BATCH_SIZE = 1000; // Delete in batches to avoid long-running transactions
const MAX_BATCHES = 100; // Safety limit

const job = new CronJob({
  name: 'cleanup-expired-sessions',
  schedule: '0 3 * * *',
  timezone: 'America/New_York',
  timeout: 10 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const db = new DatabasePool('auth');
  const s3 = new S3Client();
  const startTime = Date.now();

  const results = {
    refreshTokensDeleted: 0,
    blacklistedTokensDeleted: 0,
    passwordResetTokensDeleted: 0,
    emailVerificationTokensDeleted: 0,
    bulkExportFilesDeleted: 0,
  };

  logger.info('Starting session cleanup');

  try {
    // 1. Delete expired refresh tokens
    // Refresh tokens expire after 7 days (production) or 30 days (dev)
    let batch = 0;
    while (batch < MAX_BATCHES) {
      const result = await db.query(
        `DELETE FROM refresh_tokens
         WHERE id IN (
           SELECT id FROM refresh_tokens
           WHERE expires_at < NOW()
           ORDER BY expires_at ASC
           LIMIT $1
         )`,
        [BATCH_SIZE]
      );

      results.refreshTokensDeleted += result.rowCount || 0;

      if ((result.rowCount || 0) < BATCH_SIZE) break;
      batch++;
    }

    logger.info(`Deleted ${results.refreshTokensDeleted} expired refresh tokens`);

    // 2. Delete old blacklisted JWT tokens
    // We keep blacklisted tokens for 24 hours (longer than any JWT expiry)
    // After that, the JWT would be expired anyway so the blacklist entry is unnecessary
    const blacklistResult = await db.query(
      `DELETE FROM token_blacklist
       WHERE blacklisted_at < NOW() - INTERVAL '24 hours'`
    );
    results.blacklistedTokensDeleted = blacklistResult.rowCount || 0;
    logger.info(`Deleted ${results.blacklistedTokensDeleted} old blacklisted tokens`);

    // 3. Delete expired password reset tokens
    // These expire after 15 minutes (production) but we keep them for 24 hours for audit
    const resetResult = await db.query(
      `DELETE FROM password_reset_tokens
       WHERE created_at < NOW() - INTERVAL '24 hours'`
    );
    results.passwordResetTokensDeleted = resetResult.rowCount || 0;
    logger.info(`Deleted ${results.passwordResetTokensDeleted} expired password reset tokens`);

    // 4. Delete expired email verification tokens
    const verifyResult = await db.query(
      `DELETE FROM email_verification_tokens
       WHERE created_at < NOW() - INTERVAL '72 hours'`
    );
    results.emailVerificationTokensDeleted = verifyResult.rowCount || 0;
    logger.info(`Deleted ${results.emailVerificationTokensDeleted} expired email verification tokens`);

    // 5. Clean up FHIR bulk export files older than 24 hours
    // Bulk export generates temporary NDJSON files in S3
    try {
      const expiredExports = await s3.listObjects({
        bucket: process.env.S3_DOCUMENTS_BUCKET || 'meridian-documents-prod',
        prefix: 'bulk-export/',
        olderThan: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      if (expiredExports.length > 0) {
        await s3.deleteObjects({
          bucket: process.env.S3_DOCUMENTS_BUCKET || 'meridian-documents-prod',
          keys: expiredExports.map(obj => obj.key),
        });
        results.bulkExportFilesDeleted = expiredExports.length;
        logger.info(`Deleted ${results.bulkExportFilesDeleted} expired bulk export files`);
      }
    } catch (error) {
      // Don't fail the whole job if S3 cleanup fails
      logger.warn('Failed to clean up bulk export files', { error });
    }

    // Report metrics
    const duration = Date.now() - startTime;
    metrics.gauge('cron.session_cleanup.refresh_tokens', results.refreshTokensDeleted);
    metrics.gauge('cron.session_cleanup.blacklisted_tokens', results.blacklistedTokensDeleted);
    metrics.gauge('cron.session_cleanup.reset_tokens', results.passwordResetTokensDeleted);
    metrics.timing('cron.session_cleanup.duration', duration);

    logger.info(`Session cleanup complete in ${Math.round(duration / 1000)}s`, results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Session cleanup failed: ${errorMessage}`);
    throw error;
  } finally {
    await db.end();
  }
});

export default job;
