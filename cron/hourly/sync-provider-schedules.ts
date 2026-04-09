/**
 * Sync Provider Schedules
 *
 * Pulls provider schedule updates from external EHR systems and syncs
 * them with our scheduling-service. Handles conflict resolution when
 * a provider's external schedule differs from our internal one.
 *
 * Schedule: 0 * * * * (top of every hour)
 * Timeout: 15 minutes
 * Owner: Scheduling Team (Alex Petrov)
 */

import { CronJob } from '../lib/cron-job';
import { SchedulingService } from '../clients/scheduling-service';
import { EHRIntegrationClient } from '../clients/ehr-integration';
import { SlackNotifier } from '../lib/slack';
import { AuditLogger } from '../lib/audit';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';
import { isWithinInterval, parseISO, areIntervalsOverlapping } from 'date-fns';

interface ScheduleConflict {
  providerId: string;
  providerName: string;
  date: string;
  conflictType: 'block_overlap' | 'removed_slot_has_appointment' | 'schedule_change';
  details: string;
  internalSlot?: TimeSlot;
  externalSlot?: TimeSlot;
}

interface TimeSlot {
  start: string;
  end: string;
  type: string;
}

const job = new CronJob({
  name: 'sync-provider-schedules',
  schedule: '0 * * * *',
  timezone: 'America/New_York',
  timeout: 15 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const scheduling = new SchedulingService();
  const ehrClient = new EHRIntegrationClient();
  const slack = new SlackNotifier('#scheduling-ops');
  const audit = new AuditLogger('schedule-sync');
  const startTime = Date.now();

  const results = {
    providersChecked: 0,
    providersUpdated: 0,
    slotsAdded: 0,
    slotsRemoved: 0,
    blocksAdded: 0,
    conflicts: [] as ScheduleConflict[],
    errors: 0,
  };

  logger.info('Starting provider schedule sync');

  try {
    // Get all active providers that have EHR integration configured
    const providers = await scheduling.getProvidersWithEHRSync();
    results.providersChecked = providers.length;

    logger.info(`Syncing schedules for ${providers.length} providers`);

    for (const provider of providers) {
      try {
        // Fetch schedule from external EHR for next 7 days
        const externalSchedule = await ehrClient.getProviderSchedule({
          providerId: provider.ehrProviderId,
          ehrSystem: provider.ehrSystem,
          startDate: new Date(),
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        if (!externalSchedule) {
          logger.warn(`No schedule returned from EHR for provider ${provider.id}`);
          continue;
        }

        // Get our internal schedule for the same period
        const internalSchedule = await scheduling.getProviderSchedule({
          providerId: provider.id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        // Compare and sync
        const syncResult = reconcileSchedules(
          provider,
          internalSchedule,
          externalSchedule
        );

        // Apply non-conflicting changes
        for (const addition of syncResult.additions) {
          await scheduling.addScheduleBlock({
            providerId: provider.id,
            startTime: addition.start,
            endTime: addition.end,
            type: addition.type,
            source: 'ehr-sync',
          });
          results.slotsAdded++;
        }

        for (const removal of syncResult.removals) {
          // Check if any appointments exist in the removed slot
          const hasAppointments = await scheduling.hasAppointmentsInRange({
            providerId: provider.id,
            startTime: removal.start,
            endTime: removal.end,
          });

          if (hasAppointments) {
            // Don't remove - flag as conflict
            results.conflicts.push({
              providerId: provider.id,
              providerName: provider.name,
              date: removal.start,
              conflictType: 'removed_slot_has_appointment',
              details: `EHR shows provider unavailable ${removal.start} - ${removal.end}, but appointments exist`,
              internalSlot: removal,
            });
          } else {
            await scheduling.removeScheduleBlock({
              providerId: provider.id,
              startTime: removal.start,
              endTime: removal.end,
              source: 'ehr-sync',
            });
            results.slotsRemoved++;
          }
        }

        // Add new blocks (PTO, meetings, etc.)
        for (const block of syncResult.newBlocks) {
          await scheduling.addBlockedTime({
            providerId: provider.id,
            startTime: block.start,
            endTime: block.end,
            reason: block.type,
            source: 'ehr-sync',
          });
          results.blocksAdded++;
        }

        // Record conflicts
        results.conflicts.push(...syncResult.conflicts.map(c => ({
          ...c,
          providerId: provider.id,
          providerName: provider.name,
        })));

        if (syncResult.additions.length > 0 || syncResult.removals.length > 0 || syncResult.newBlocks.length > 0) {
          results.providersUpdated++;

          await audit.log({
            action: 'SCHEDULE_SYNCED',
            resourceType: 'provider',
            resourceId: provider.id,
            details: {
              slotsAdded: syncResult.additions.length,
              slotsRemoved: syncResult.removals.length,
              blocksAdded: syncResult.newBlocks.length,
              conflicts: syncResult.conflicts.length,
            },
          });
        }

      } catch (error) {
        results.errors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Schedule sync failed for provider ${provider.id}: ${errorMessage}`);
      }
    }

    // Notify about conflicts
    if (results.conflicts.length > 0) {
      let message = `*Schedule Sync Conflicts (${results.conflicts.length})*\n\n`;
      for (const conflict of results.conflicts) {
        message += `- *${conflict.providerName}* (${conflict.date})\n`;
        message += `  ${conflict.details}\n`;
      }
      message += `\nPlease review and resolve in the scheduling admin panel.`;

      await slack.send(message);
    }

    // Metrics
    const duration = Date.now() - startTime;
    metrics.gauge('cron.schedule_sync.providers_checked', results.providersChecked);
    metrics.gauge('cron.schedule_sync.providers_updated', results.providersUpdated);
    metrics.gauge('cron.schedule_sync.slots_added', results.slotsAdded);
    metrics.gauge('cron.schedule_sync.slots_removed', results.slotsRemoved);
    metrics.gauge('cron.schedule_sync.conflicts', results.conflicts.length);
    metrics.timing('cron.schedule_sync.duration', duration);

    logger.info(`Schedule sync complete in ${Math.round(duration / 1000)}s`, results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Fatal error in schedule sync: ${errorMessage}`);
    throw error;
  }
});

function reconcileSchedules(
  provider: any,
  internal: any,
  external: any
): {
  additions: TimeSlot[];
  removals: TimeSlot[];
  newBlocks: TimeSlot[];
  conflicts: ScheduleConflict[];
} {
  // Simplified reconciliation logic
  // In production, this is much more complex with edge cases for:
  // - Partial overlaps
  // - Different slot granularity between systems
  // - Provider-specific override rules
  // - Holiday handling
  // - Multi-location providers

  return {
    additions: [],
    removals: [],
    newBlocks: [],
    conflicts: [],
  };
}

export default job;
