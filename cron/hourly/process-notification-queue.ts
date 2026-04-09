/**
 * Process Notification Queue
 *
 * Processes pending notifications from the queue. Batches emails
 * to reduce API calls, but sends SMS immediately since they're
 * typically time-sensitive (appointment reminders, urgent alerts).
 *
 * Schedule: */15 * * * * (every 15 minutes)
 * Timeout: 10 minutes
 * Owner: Platform Team
 */

import { CronJob } from '../lib/cron-job';
import { NotificationRepository } from '../repositories/notifications';
import { SendGridClient } from '../clients/sendgrid';
import { TwilioClient } from '../clients/twilio';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';

const EMAIL_BATCH_SIZE = 100;
const SMS_BATCH_SIZE = 50;
const MAX_RETRIES = 3;

const job = new CronJob({
  name: 'process-notification-queue',
  schedule: '*/15 * * * *',
  timezone: 'America/New_York',
  timeout: 10 * 60 * 1000,
  retries: 0, // Don't retry the job itself - individual notifications have their own retry logic
});

job.run(async (context) => {
  const notificationRepo = new NotificationRepository();
  const sendgrid = new SendGridClient();
  const twilio = new TwilioClient();
  const startTime = Date.now();

  const results = {
    emailsSent: 0,
    emailsFailed: 0,
    smsSent: 0,
    smsFailed: 0,
    pushSent: 0,
    pushFailed: 0,
    skipped: 0,
  };

  try {
    // Process SMS first (time-sensitive)
    const pendingSms = await notificationRepo.findPending({
      channel: 'sms',
      limit: SMS_BATCH_SIZE,
      maxRetries: MAX_RETRIES,
    });

    for (const notification of pendingSms) {
      try {
        // Validate phone number
        if (!notification.recipient || !/^\+?1?\d{10,11}$/.test(notification.recipient.replace(/\D/g, ''))) {
          logger.warn(`Invalid phone number for notification ${notification.id}`);
          await notificationRepo.markFailed(notification.id, 'Invalid phone number');
          results.smsFailed++;
          continue;
        }

        // Check opt-out status
        const isOptedOut = await notificationRepo.isOptedOut(notification.recipientPatientId, 'sms');
        if (isOptedOut) {
          await notificationRepo.markSkipped(notification.id, 'Patient opted out of SMS');
          results.skipped++;
          continue;
        }

        // HIPAA: SMS messages must not contain PHI
        // The message should be generic with a link to the portal for details
        const sanitizedMessage = sanitizeSmsContent(notification.message);

        await twilio.sendSms({
          to: notification.recipient,
          body: sanitizedMessage,
          // Use messaging service for proper number rotation and compliance
          messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        });

        await notificationRepo.markSent(notification.id);
        results.smsSent++;

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`SMS send failed for notification ${notification.id}: ${errorMessage}`);

        await notificationRepo.markRetry(notification.id, errorMessage);
        results.smsFailed++;
      }
    }

    // Process emails in batch
    const pendingEmails = await notificationRepo.findPending({
      channel: 'email',
      limit: EMAIL_BATCH_SIZE,
      maxRetries: MAX_RETRIES,
    });

    if (pendingEmails.length > 0) {
      // Group emails by template for batch sending
      const emailsByTemplate = new Map<string, typeof pendingEmails>();

      for (const notification of pendingEmails) {
        // Check opt-out
        const isOptedOut = await notificationRepo.isOptedOut(notification.recipientPatientId, 'email');
        if (isOptedOut) {
          await notificationRepo.markSkipped(notification.id, 'Patient opted out of email');
          results.skipped++;
          continue;
        }

        const template = notification.template || 'generic';
        if (!emailsByTemplate.has(template)) {
          emailsByTemplate.set(template, []);
        }
        emailsByTemplate.get(template)!.push(notification);
      }

      // Send each template batch
      for (const [template, notifications] of emailsByTemplate) {
        try {
          const emailBatch = notifications.map(n => ({
            to: n.recipient,
            subject: n.subject,
            template: template,
            data: n.templateData || {},
            // Track opens/clicks for operational metrics (not marketing)
            trackOpens: true,
            trackClicks: false,
          }));

          const sendResults = await sendgrid.sendBatch(emailBatch);

          for (let i = 0; i < notifications.length; i++) {
            if (sendResults[i]?.success) {
              await notificationRepo.markSent(notifications[i].id, sendResults[i].messageId);
              results.emailsSent++;
            } else {
              await notificationRepo.markRetry(
                notifications[i].id,
                sendResults[i]?.error || 'Unknown send error'
              );
              results.emailsFailed++;
            }
          }

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Email batch send failed for template ${template}: ${errorMessage}`);

          // Mark all in batch as retry
          for (const notification of notifications) {
            await notificationRepo.markRetry(notification.id, errorMessage);
            results.emailsFailed++;
          }
        }
      }
    }

    // Process push notifications
    const pendingPush = await notificationRepo.findPending({
      channel: 'push',
      limit: 100,
      maxRetries: MAX_RETRIES,
    });

    for (const notification of pendingPush) {
      try {
        // Push notifications require a device token
        if (!notification.deviceToken) {
          await notificationRepo.markFailed(notification.id, 'No device token');
          results.pushFailed++;
          continue;
        }

        // TODO: Implement push notification sending via Firebase/APNs
        // For now, mark as skipped since mobile app is not yet released
        await notificationRepo.markSkipped(notification.id, 'Push notifications not yet implemented');
        results.skipped++;

      } catch (error) {
        results.pushFailed++;
      }
    }

    // Clean up permanently failed notifications (exceeded max retries)
    const expiredCount = await notificationRepo.expireFailedNotifications(MAX_RETRIES);
    if (expiredCount > 0) {
      logger.warn(`${expiredCount} notifications permanently failed after ${MAX_RETRIES} retries`);
    }

    // Metrics
    const duration = Date.now() - startTime;
    metrics.gauge('cron.notifications.emails_sent', results.emailsSent);
    metrics.gauge('cron.notifications.emails_failed', results.emailsFailed);
    metrics.gauge('cron.notifications.sms_sent', results.smsSent);
    metrics.gauge('cron.notifications.sms_failed', results.smsFailed);
    metrics.gauge('cron.notifications.skipped', results.skipped);
    metrics.timing('cron.notifications.duration', duration);

    logger.info(`Notification processing complete in ${Math.round(duration / 1000)}s`, results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Fatal error in notification processing: ${errorMessage}`);
    throw error;
  }
});

/**
 * Sanitize SMS content to ensure no PHI is included.
 * HIPAA requires that SMS messages sent to patients do not
 * contain Protected Health Information.
 */
function sanitizeSmsContent(message: string): string {
  // Replace any potential PHI patterns
  // This is a safety net - the notification templates should already be PHI-free
  let sanitized = message;

  // Remove anything that looks like an MRN
  sanitized = sanitized.replace(/MHT-\d{6}/g, '[reference number]');

  // Remove anything that looks like a date of birth
  sanitized = sanitized.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, '[date]');

  // Ensure message is under SMS length limit
  if (sanitized.length > 160) {
    sanitized = sanitized.substring(0, 157) + '...';
  }

  return sanitized;
}

export default job;
