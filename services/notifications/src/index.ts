import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import amqplib from 'amqplib';
import notificationRoutes from './routes/notifications';
import { EmailService } from './services/emailService';
import { SMSService } from './services/smsService';
import { logger } from './utils/logger';
import { pool } from './db';

const app = express();
const PORT = process.env.NOTIFICATION_SERVICE_PORT || 3003;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';

// Queue names
const NOTIFICATION_QUEUE = 'meridian.notifications';
const NOTIFICATION_DLQ = 'meridian.notifications.dlq';
// TODO: add separate queues for high-priority notifications (e.g., critical lab results)
// Right now everything goes through the same queue which means a burst of
// appointment reminders can delay critical notifications

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  // TODO: check RabbitMQ connection health too
  // and maybe SendGrid API status
  let dbHealthy = false;
  try {
    await pool.query('SELECT 1');
    dbHealthy = true;
  } catch (e) {
    // db is down
  }

  res.json({
    status: dbHealthy ? 'ok' : 'degraded',
    service: 'notifications-service',
    version: process.env.npm_package_version || '1.8.7',
    uptime: process.uptime(),
    checks: {
      database: dbHealthy ? 'connected' : 'disconnected',
      // rabbit: rabbitConnected ? 'connected' : 'disconnected', // TODO
    },
  });
});

app.use('/api/v1/notifications', notificationRoutes);

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error in notifications service', {
    error: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    path: req.path,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// RabbitMQ consumer for notification events
let rabbitConnection: amqplib.Connection | null = null;
let rabbitChannel: amqplib.Channel | null = null;

async function setupRabbitMQ() {
  try {
    rabbitConnection = await amqplib.connect(RABBITMQ_URL);
    rabbitChannel = await rabbitConnection.createChannel();

    // Set up dead letter exchange for failed notifications
    await rabbitChannel.assertExchange('meridian.dlx', 'direct', { durable: true });
    await rabbitChannel.assertQueue(NOTIFICATION_DLQ, {
      durable: true,
      arguments: {
        'x-message-ttl': 7 * 24 * 60 * 60 * 1000, // keep dead letters for 7 days
      },
    });
    await rabbitChannel.bindQueue(NOTIFICATION_DLQ, 'meridian.dlx', NOTIFICATION_QUEUE);

    // Main notification queue
    await rabbitChannel.assertQueue(NOTIFICATION_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'meridian.dlx',
        'x-dead-letter-routing-key': NOTIFICATION_QUEUE,
      },
    });

    // Prefetch 10 messages at a time
    // TODO: tune this based on load testing results
    // We set it to 10 arbitrarily and never measured whether that's optimal
    await rabbitChannel.prefetch(10);

    logger.info('RabbitMQ connected, consuming from queue', { queue: NOTIFICATION_QUEUE });

    rabbitChannel.consume(NOTIFICATION_QUEUE, async (msg) => {
      if (!msg) return;

      try {
        const notification = JSON.parse(msg.content.toString());

        logger.info('Processing notification', {
          type: notification.type,
          channel: notification.channel,
          recipientId: notification.recipientId,
          // HIPAA: don't log the actual notification content
        });

        await processNotification(notification);

        rabbitChannel!.ack(msg);
      } catch (error: any) {
        logger.error('Failed to process notification', {
          error: error.message,
          // Check if this message has been retried already
          retryCount: (msg.properties.headers?.['x-retry-count'] || 0),
        });

        const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;

        if (retryCount >= 3) {
          // Max retries reached - send to DLQ
          logger.error('Notification failed after max retries, sending to DLQ', {
            retryCount,
            messageId: msg.properties.messageId,
          });
          rabbitChannel!.nack(msg, false, false); // false = don't requeue (goes to DLQ)
        } else {
          // Retry with exponential backoff
          // NOTE: amqplib doesn't natively support delayed requeue
          // so we're just immediately requeueing which isn't great
          // TODO: use a delayed message exchange plugin or implement
          // proper retry with setTimeout
          rabbitChannel!.nack(msg, false, true); // true = requeue
        }
      }
    });

    // Handle connection close
    rabbitConnection.on('close', () => {
      logger.error('RabbitMQ connection closed, attempting reconnect...');
      setTimeout(setupRabbitMQ, 5000);
    });

    rabbitConnection.on('error', (err) => {
      logger.error('RabbitMQ connection error', { error: err.message });
    });

  } catch (error: any) {
    logger.error('Failed to connect to RabbitMQ', { error: error.message });
    // Retry connection after delay
    setTimeout(setupRabbitMQ, 5000);
  }
}

const emailService = new EmailService();
const smsService = new SMSService();

async function processNotification(notification: {
  type: string;
  channel: string;
  recipientId: string;
  templateId?: string;
  data: Record<string, any>;
  priority?: 'low' | 'normal' | 'high' | 'critical';
}) {
  // Check user's notification preferences
  // TODO: cache preferences in Redis to avoid DB lookup on every notification
  const prefs = await getUserNotificationPreferences(notification.recipientId);

  // Critical notifications always go through regardless of preferences
  // (e.g., security alerts, critical lab results)
  const isCritical = notification.priority === 'critical';

  switch (notification.channel) {
    case 'email':
      if (isCritical || prefs?.email !== false) {
        await emailService.sendTemplatedEmail(
          notification.recipientId,
          notification.templateId || notification.type,
          notification.data
        );
      }
      break;

    case 'sms':
      if (isCritical || prefs?.sms === true) { // SMS is opt-in
        await smsService.sendSMS(
          notification.recipientId,
          notification.templateId || notification.type,
          notification.data
        );
      }
      break;

    case 'push':
      // TODO: implement push notifications
      // We had Firebase set up but the config got lost during the
      // infrastructure migration. Need to set it up again.
      logger.warn('Push notifications not implemented yet', {
        recipientId: notification.recipientId,
      });
      break;

    case 'all':
      // Send through all enabled channels
      // TODO: this is inefficient - should batch/parallelize
      if (isCritical || prefs?.email !== false) {
        await emailService.sendTemplatedEmail(
          notification.recipientId,
          notification.templateId || notification.type,
          notification.data
        );
      }
      if (isCritical || prefs?.sms === true) {
        await smsService.sendSMS(
          notification.recipientId,
          notification.templateId || notification.type,
          notification.data
        );
      }
      break;

    default:
      logger.warn('Unknown notification channel', { channel: notification.channel });
  }

  // Record notification in history
  await recordNotification(notification);
}

async function getUserNotificationPreferences(userId: string): Promise<any> {
  try {
    const result = await pool.query(
      `SELECT notification_preferences FROM users WHERE id = $1`,
      [userId]
    );
    // Wait, this is querying the users table which is in the auth service's DB
    // TODO: either replicate notification preferences to our own DB
    // or call the auth service API
    // For now this works because we're sharing the same DB in dev/staging
    // but in prod the services have separate databases
    return result.rows[0]?.notification_preferences || { email: true, sms: false, push: true };
  } catch {
    return { email: true, sms: false, push: true };
  }
}

async function recordNotification(notification: any) {
  try {
    await pool.query(
      `INSERT INTO notifications (id, type, channel, status, recipient_id, template_id, data, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'sent', $3, $4, $5, NOW())`,
      [
        notification.type,
        notification.channel,
        notification.recipientId,
        notification.templateId,
        JSON.stringify(notification.data),
      ]
    );
  } catch (error: any) {
    // Don't fail the notification if recording fails
    logger.error('Failed to record notification', { error: error.message });
  }
}

// Start server
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Notifications service listening on port ${PORT}`);
    // Connect to RabbitMQ
    setupRabbitMQ();
  });
}

export default app;
