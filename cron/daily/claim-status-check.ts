/**
 * Daily Claim Status Check
 *
 * Checks the status of submitted claims with clearinghouses and updates
 * claim statuses in our system. Runs daily at 6:00 AM ET.
 *
 * Schedule: 0 6 * * * (cron)
 * Timeout: 30 minutes
 * Owner: Revenue Cycle Team (Priya Sharma)
 */

import { CronJob } from '../lib/cron-job';
import { ClaimsRepository } from '../repositories/claims';
import { ClearinghouseClient } from '../clients/clearinghouse';
import { SlackNotifier } from '../lib/slack';
import { AuditLogger } from '../lib/audit';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';

interface ClaimStatusResult {
  claimId: string;
  previousStatus: string;
  newStatus: string;
  clearinghouseTrackingId: string;
  adjudicationDate?: string;
  paidAmount?: number;
  denialReason?: string;
  remarkCodes?: string[];
}

const BATCH_SIZE = 100;
const MAX_CLAIM_AGE_DAYS = 365; // Don't check claims older than 1 year
const CLEARINGHOUSE_RATE_LIMIT_MS = 200; // 200ms between API calls

const job = new CronJob({
  name: 'claim-status-check',
  schedule: '0 6 * * *',
  timezone: 'America/New_York',
  timeout: 30 * 60 * 1000, // 30 minutes
  retries: 2,
});

job.run(async (context) => {
  const claimsRepo = new ClaimsRepository();
  const clearinghouse = new ClearinghouseClient();
  const slack = new SlackNotifier('#billing-ops');
  const audit = new AuditLogger('claim-status-check');

  const startTime = Date.now();
  const results = {
    total: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    statusChanges: [] as ClaimStatusResult[],
    newDenials: [] as ClaimStatusResult[],
    newPayments: [] as ClaimStatusResult[],
  };

  logger.info('Starting daily claim status check');

  try {
    // Get all claims in submitted/accepted status that need checking
    const pendingClaims = await claimsRepo.findByStatuses(
      ['submitted', 'accepted', 'pending'],
      {
        maxAgeDays: MAX_CLAIM_AGE_DAYS,
        orderBy: 'submitted_at',
        order: 'ASC',
      }
    );

    results.total = pendingClaims.length;
    logger.info(`Found ${results.total} claims to check`);

    if (results.total === 0) {
      logger.info('No claims to check. Exiting.');
      return;
    }

    // Process in batches to avoid overwhelming the clearinghouse API
    for (let i = 0; i < pendingClaims.length; i += BATCH_SIZE) {
      const batch = pendingClaims.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(pendingClaims.length / BATCH_SIZE);

      logger.info(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} claims)`);

      for (const claim of batch) {
        try {
          // Rate limit clearinghouse API calls
          await sleep(CLEARINGHOUSE_RATE_LIMIT_MS);

          // Check claim status with clearinghouse
          const statusResponse = await clearinghouse.checkClaimStatus({
            trackingId: claim.clearinghouseTrackingId,
            claimId: claim.claimId,
            payerId: claim.payerId,
            memberId: claim.subscriberMemberId,
            serviceDate: claim.serviceDate,
          });

          if (!statusResponse || statusResponse.status === claim.status) {
            results.unchanged++;
            continue;
          }

          // Map clearinghouse status to our internal status
          const newStatus = mapClearinghouseStatus(statusResponse.statusCode);

          const statusResult: ClaimStatusResult = {
            claimId: claim.claimId,
            previousStatus: claim.status,
            newStatus,
            clearinghouseTrackingId: claim.clearinghouseTrackingId,
            adjudicationDate: statusResponse.adjudicationDate,
            paidAmount: statusResponse.paidAmount,
            denialReason: statusResponse.denialReason,
            remarkCodes: statusResponse.remarkCodes,
          };

          // Update claim status in our database
          await claimsRepo.updateStatus(claim.claimId, {
            status: newStatus,
            adjudicatedAt: statusResponse.adjudicationDate
              ? new Date(statusResponse.adjudicationDate)
              : undefined,
            paidAmount: statusResponse.paidAmount,
            denialReasonCode: statusResponse.denialReason,
            remarkCodes: statusResponse.remarkCodes,
            clearinghouseResponse: statusResponse.rawResponse,
            updatedBy: 'cron:claim-status-check',
          });

          // Audit log the status change
          await audit.log({
            action: 'CLAIM_STATUS_UPDATED',
            resourceType: 'claim',
            resourceId: claim.claimId,
            patientId: claim.patientId,
            details: {
              previousStatus: claim.status,
              newStatus,
              paidAmount: statusResponse.paidAmount,
            },
          });

          results.updated++;
          results.statusChanges.push(statusResult);

          // Track specific status changes
          if (newStatus === 'denied') {
            results.newDenials.push(statusResult);
          } else if (newStatus === 'paid') {
            results.newPayments.push(statusResult);
          }

          // Check for timely filing risk
          if (newStatus === 'denied' && statusResponse.denialReason === 'TIMELY_FILING') {
            logger.error(`TIMELY FILING DENIAL: Claim ${claim.claimId}`);
            await slack.sendUrgent(
              `Timely filing denial detected for claim ${claim.claimId}. ` +
              `Patient: ${claim.patientMrn}. Payer: ${claim.payerName}. ` +
              `Service date: ${claim.serviceDate}. Immediate review required.`
            );
          }

        } catch (error) {
          results.errors++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Error checking claim ${claim.claimId}: ${errorMessage}`);

          // Don't fail the entire job for one claim error
          metrics.increment('cron.claim_status_check.errors', {
            claim_id: claim.claimId,
            payer_id: claim.payerId,
          });
        }
      }

      // Log progress
      const progress = Math.min(i + BATCH_SIZE, pendingClaims.length);
      logger.info(`Progress: ${progress}/${pendingClaims.length} claims checked`);
    }

    // Send summary to Slack
    const duration = Math.round((Date.now() - startTime) / 1000);
    const totalPayments = results.newPayments.reduce(
      (sum, r) => sum + (r.paidAmount || 0),
      0
    );

    await slack.send(
      `*Daily Claim Status Check Complete*\n` +
      `Total checked: ${results.total}\n` +
      `Updated: ${results.updated}\n` +
      `Unchanged: ${results.unchanged}\n` +
      `Errors: ${results.errors}\n` +
      `New payments: ${results.newPayments.length} ($${totalPayments.toFixed(2)})\n` +
      `New denials: ${results.newDenials.length}\n` +
      `Duration: ${duration}s`
    );

    // Report metrics
    metrics.gauge('cron.claim_status_check.total', results.total);
    metrics.gauge('cron.claim_status_check.updated', results.updated);
    metrics.gauge('cron.claim_status_check.errors', results.errors);
    metrics.gauge('cron.claim_status_check.new_payments', results.newPayments.length);
    metrics.gauge('cron.claim_status_check.new_denials', results.newDenials.length);
    metrics.gauge('cron.claim_status_check.payment_amount', totalPayments);
    metrics.timing('cron.claim_status_check.duration', Date.now() - startTime);

    // Alert if error rate is high
    if (results.errors > results.total * 0.1) {
      await slack.sendUrgent(
        `High error rate in claim status check: ${results.errors}/${results.total} claims failed. ` +
        `Check clearinghouse connectivity.`
      );
    }

    logger.info('Daily claim status check complete', results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Fatal error in claim status check: ${errorMessage}`);

    await slack.sendUrgent(
      `Claim status check FAILED: ${errorMessage}. ` +
      `Manual check required.`
    );

    throw error; // Re-throw to trigger job retry
  }
});

function mapClearinghouseStatus(statusCode: string): string {
  const statusMap: Record<string, string> = {
    'A0': 'accepted',      // Acknowledgement/Receipt
    'A1': 'accepted',      // Accepted for processing
    'A2': 'accepted',      // Accepted - awaiting review
    'A3': 'adjudicated',   // Adjudicated - payment pending
    'A4': 'paid',          // Finalized - payment issued
    'R0': 'rejected',      // Rejected - invalid format
    'R1': 'rejected',      // Rejected - missing info
    'D0': 'denied',        // Denied
    'D1': 'denied',        // Denied - not covered
    'D2': 'denied',        // Denied - timely filing
    'P0': 'pending',       // Pending review
    'P1': 'pending',       // Pending additional info
  };

  return statusMap[statusCode] || 'pending';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default job;
