/**
 * Claims Engine - Service Entry Point
 *
 * Sets up Express server, RabbitMQ consumers, and database connections.
 * This service handles insurance claim submission, adjudication, ERA/EOB
 * processing, and denial management.
 *
 * Architecture:
 * - REST API for synchronous operations (CRUD, status, bulk)
 * - RabbitMQ workers for async operations (submission, remittance processing)
 * - PostgreSQL for persistence
 * - Redis for caching (payer configs, fee schedules) and rate limiting
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { Pool } from 'pg';
import Redis from 'ioredis';
import * as amqp from 'amqplib';
import winston from 'winston';
import dotenv from 'dotenv';

import { claimsRouter } from './routes/claims';
import { adjudicationRouter } from './routes/adjudication';

dotenv.config();

// Logger setup
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), winston.format.simple())
  ),
  defaultMeta: { service: 'claims-engine' },
  transports: [
    new winston.transports.Console(),
    // In production we also ship to CloudWatch via a sidecar but
    // we still log to stdout for local dev / debugging
  ],
});

// Database connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'meridian_claims',
  user: process.env.DB_USER || 'claims_service',
  password: process.env.DB_PASSWORD || 'claims_service_dev',
  max: parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // HACK: we bumped this from 10 to 20 because we were exhausting the pool
  // during peak hours (M-F 9am-12pm ET). The real fix is to optimize the
  // N+1 queries in claimProcessor.ts but nobody wants to touch that code.
  // - Marcus 2024-09
});

// Redis connection
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '2'),
  keyPrefix: 'claims:',
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    logger.warn(`Redis connection retry attempt ${times}, delay ${delay}ms`);
    return delay;
  },
});

redis.on('error', (err) => {
  // Don't crash the service if Redis goes down - we can operate without it
  // (just slower). This has happened twice in prod and both times it was
  // the Redis cluster running OOM because of the session service.
  logger.error('Redis connection error', { error: err.message });
});

// RabbitMQ connection - this is the hacky part
let rabbitConnection: amqp.Connection | null = null;
let rabbitChannel: amqp.Channel | null = null;

const QUEUES = {
  CLAIM_SUBMISSION: 'claims.submission',
  CLAIM_SUBMISSION_DLQ: 'claims.submission.dlq',
  REMITTANCE_PROCESSING: 'claims.remittance.processing',
  REMITTANCE_PROCESSING_DLQ: 'claims.remittance.processing.dlq',
  CLAIM_STATUS_UPDATE: 'claims.status.update',
  CLAIM_NOTIFICATION: 'claims.notification',
};

async function connectRabbitMQ(retries = 5): Promise<void> {
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      rabbitConnection = await amqp.connect(rabbitUrl);
      rabbitChannel = await rabbitConnection.createChannel();

      // Set prefetch to 10 - we process claims in small batches
      // WARNING: if you increase this, make sure the DB pool can handle it.
      // We learned this the hard way. (see Incident Report 2024-03-14)
      await rabbitChannel.prefetch(10);

      // Assert queues with DLQ configuration
      for (const [key, queueName] of Object.entries(QUEUES)) {
        if (key.endsWith('_DLQ')) {
          await rabbitChannel.assertQueue(queueName, { durable: true });
        } else {
          await rabbitChannel.assertQueue(queueName, {
            durable: true,
            arguments: {
              'x-dead-letter-exchange': '',
              'x-dead-letter-routing-key': `${queueName}.dlq`,
              'x-message-ttl': 86400000, // 24 hours
            },
          });
        }
      }

      // Set up consumers
      // NOTE: we import workers here to avoid circular dependency issues.
      // This is ugly and we should use a proper DI container.
      const { handleClaimSubmission } = await import('./workers/claimSubmission.worker');
      const { handleRemittanceProcessing } = await import('./workers/remittanceProcessor.worker');

      rabbitChannel.consume(QUEUES.CLAIM_SUBMISSION, async (msg) => {
        if (!msg) return;
        try {
          await handleClaimSubmission(msg, pool, redis, logger);
          rabbitChannel!.ack(msg);
        } catch (err: any) {
          logger.error('Failed to process claim submission message', {
            error: err.message,
            messageId: msg.properties.messageId,
          });
          // Nack with requeue=false sends to DLQ
          rabbitChannel!.nack(msg, false, false);
        }
      });

      rabbitChannel.consume(QUEUES.REMITTANCE_PROCESSING, async (msg) => {
        if (!msg) return;
        try {
          await handleRemittanceProcessing(msg, pool, redis, logger);
          rabbitChannel!.ack(msg);
        } catch (err: any) {
          logger.error('Failed to process remittance message', {
            error: err.message,
            messageId: msg.properties.messageId,
          });
          rabbitChannel!.nack(msg, false, false);
        }
      });

      rabbitConnection.on('close', () => {
        logger.warn('RabbitMQ connection closed, attempting reconnect...');
        // HACK: wait 5 seconds then try to reconnect.
        // This is not great - we should use a proper reconnection strategy
        // with exponential backoff. But this has worked "well enough" for now.
        setTimeout(() => connectRabbitMQ(retries), 5000);
      });

      rabbitConnection.on('error', (err) => {
        logger.error('RabbitMQ connection error', { error: err.message });
      });

      logger.info('RabbitMQ connected and consumers registered');
      return;
    } catch (err: any) {
      logger.warn(`RabbitMQ connection attempt ${attempt}/${retries} failed`, {
        error: err.message,
      });
      if (attempt < retries) {
        // Wait before retrying - linear backoff (should be exponential, I know)
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
  }

  // If all retries fail, log error but don't crash.
  // The REST API should still work, just the async workers won't process.
  // This happens occasionally in dev/staging when RabbitMQ isn't up yet.
  logger.error('Failed to connect to RabbitMQ after all retries. Async workers will not process.');
}

// Express app setup
const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '5mb' })); // ERA files can be large
app.use(express.urlencoded({ extended: true }));

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) },
    skip: (req) => req.url === '/health' || req.url === '/ready',
  }));
}

// Make pool and redis available to routes via app.locals
// (yes, this is not ideal - should use proper dependency injection)
app.locals.pool = pool;
app.locals.redis = redis;
app.locals.logger = logger;
app.locals.rabbitChannel = rabbitChannel;
app.locals.queues = QUEUES;

// Health check endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'claims-engine', timestamp: new Date().toISOString() });
});

app.get('/ready', async (req, res) => {
  const checks: Record<string, string> = {};
  try {
    await pool.query('SELECT 1');
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }
  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
  }
  checks.rabbitmq = rabbitConnection ? 'ok' : 'disconnected';

  const allOk = Object.values(checks).every((v) => v === 'ok');
  // We return 200 even if RabbitMQ is down because the REST API still works.
  // This is debatable but the alternative is the LB pulling us out of rotation
  // for what is a partial outage. We've gone back and forth on this.
  const isReady = checks.database === 'ok'; // only hard-fail on DB being down
  res.status(isReady ? 200 : 503).json({ ready: isReady, checks });
});

// Routes
app.use('/api/v1/claims', claimsRouter);
app.use('/api/v1/adjudication', adjudicationRouter);

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const statusCode = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error'
    : err.message;

  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    statusCode,
  });

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// Start the server
const PORT = parseInt(process.env.PORT || '3004');

async function start(): Promise<void> {
  try {
    // Test DB connection first
    const dbResult = await pool.query('SELECT NOW()');
    logger.info('Database connected', { serverTime: dbResult.rows[0].now });

    // Connect RabbitMQ (non-blocking - we don't want to delay server start)
    // RACE CONDITION: If a request comes in before RabbitMQ is connected and
    // tries to publish a message, it will fail. We handle this in the routes
    // by checking if rabbitChannel is null, but it's not great.
    // TODO: add a startup readiness gate (INFRA-3001)
    connectRabbitMQ().catch((err) => {
      logger.error('RabbitMQ setup failed', { error: err });
    });

    app.listen(PORT, () => {
      logger.info(`Claims Engine listening on port ${PORT}`, {
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
      });
    });
  } catch (err: any) {
    logger.error('Failed to start Claims Engine', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown...');
  try {
    if (rabbitChannel) await rabbitChannel.close();
    if (rabbitConnection) await rabbitConnection.close();
    await redis.quit();
    await pool.end();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err: any) {
    logger.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  // Don't exit - just log. We've had cases where a single failed promise
  // in a non-critical code path took down the whole service.
});

start();

export { app, pool, redis, logger };
