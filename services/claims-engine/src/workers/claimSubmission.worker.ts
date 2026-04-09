/**
 * Claim Submission Worker
 *
 * RabbitMQ consumer that processes claim submission messages.
 * When a claim is submitted via the REST API, it gets published to
 * the claims.submission queue. This worker picks it up and runs
 * the full processing pipeline (validation, X12 generation, etc.)
 *
 * Worker concurrency is controlled by the channel prefetch setting
 * in index.ts (currently 10). Each message is processed independently.
 *
 * If processing fails, the message is nacked and sent to the DLQ.
 * The ops team monitors the DLQ and manually retries or investigates
 * failed messages. We should probably have an automated retry with
 * backoff but haven't gotten to it.
 */

import { ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import Redis from 'ioredis';
import winston from 'winston';
import { processClaim } from '../services/claimProcessor';

interface ClaimSubmissionMessage {
  claimId: string;
  claimNumber?: string;
  payerId?: string;
  submittedBy: string;
  submittedAt: string;
  retryCount?: number;
}

/**
 * Handle a claim submission message from RabbitMQ.
 *
 * This is called by the consumer set up in index.ts.
 * If this function throws, the message will be nacked to the DLQ.
 */
export async function handleClaimSubmission(
  msg: ConsumeMessage,
  pool: Pool,
  redis: Redis,
  logger: winston.Logger
): Promise<void> {
  let message: ClaimSubmissionMessage;

  try {
    message = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error('Failed to parse claim submission message', {
      content: msg.content.toString().substring(0, 200),
      error: (err as Error).message,
    });
    throw err; // nack to DLQ - can't parse means can't process
  }

  const { claimId, claimNumber, submittedBy } = message;
  const retryCount = parseInt(msg.properties.headers?.['x-retry-count'] || '0', 10);

  logger.info('Processing claim submission', {
    claimId,
    claimNumber,
    submittedBy,
    retryCount,
    messageId: msg.properties.messageId,
  });

  // Track processing time
  const startTime = Date.now();

  // Set a processing lock in Redis to prevent double-processing
  // This can happen if the message is redelivered before the first
  // processing attempt completes (e.g., after a consumer restart)
  const lockKey = `lock:claim:${claimId}`;
  const lockAcquired = await redis.set(lockKey, 'processing', 'EX', 300, 'NX');

  if (!lockAcquired) {
    logger.warn('Claim is already being processed (lock exists)', { claimId });
    // Don't throw - just return. The message will be acked and the
    // other processing attempt will handle it.
    // POTENTIAL BUG: if the other processing attempt crashes and doesn't
    // release the lock, this message is lost. The lock TTL of 300s
    // provides some protection but it's not perfect.
    return;
  }

  try {
    await processClaim(claimId, pool, redis, logger);

    const processingTimeMs = Date.now() - startTime;
    logger.info('Claim submission processed successfully', {
      claimId,
      claimNumber,
      processingTimeMs,
    });

    // Update metrics in Redis
    try {
      await redis.incr('metrics:claims:processed');
      await redis.lpush('metrics:claims:processing_times', processingTimeMs.toString());
      await redis.ltrim('metrics:claims:processing_times', 0, 999); // keep last 1000
    } catch {
      // Metrics are non-critical
    }
  } catch (err: any) {
    const processingTimeMs = Date.now() - startTime;
    logger.error('Claim submission processing failed', {
      claimId,
      claimNumber,
      error: err.message,
      stack: err.stack,
      retryCount,
      processingTimeMs,
    });

    // Update error metrics
    try {
      await redis.incr('metrics:claims:errors');
      await redis.hset('metrics:claims:last_error', {
        claimId,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-critical
    }

    throw err; // rethrow to nack the message
  } finally {
    // Release the lock
    try {
      await redis.del(lockKey);
    } catch {
      // If we can't release the lock, it will expire in 300s
    }
  }
}

/**
 * Standalone worker mode - can be run as a separate process.
 * Usage: npm run worker:claims
 *
 * In production, this is run as a separate ECS task/container.
 * In dev, the workers are inline in the main process (see index.ts).
 */
async function startStandaloneWorker(): Promise<void> {
  // Only run standalone if executed directly
  if (require.main !== module) return;

  const dotenv = require('dotenv');
  dotenv.config();

  const winstonLib = require('winston');
  const logger = winstonLib.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winstonLib.format.combine(
      winstonLib.format.timestamp(),
      winstonLib.format.json()
    ),
    defaultMeta: { service: 'claims-worker', worker: 'submission' },
    transports: [new winstonLib.transports.Console()],
  });

  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'meridian_claims',
    user: process.env.DB_USER || 'claims_service',
    password: process.env.DB_PASSWORD || 'claims_service_dev',
    max: 10,
  });

  const RedisLib = require('ioredis');
  const redis = new RedisLib({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '2'),
    keyPrefix: 'claims:',
  });

  const amqp = require('amqplib');
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

  try {
    const connection = await amqp.connect(rabbitUrl);
    const channel = await connection.createChannel();
    await channel.prefetch(parseInt(process.env.WORKER_PREFETCH || '10'));

    const queueName = 'claims.submission';
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': `${queueName}.dlq`,
      },
    });

    logger.info('Claim submission worker started', { queue: queueName });

    channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        await handleClaimSubmission(msg, pool, redis, logger);
        channel.ack(msg);
      } catch (err: any) {
        logger.error('Worker: message processing failed', {
          error: err.message,
          messageId: msg.properties.messageId,
        });
        channel.nack(msg, false, false);
      }
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down worker...');
      await channel.close();
      await connection.close();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
  } catch (err: any) {
    logger.error('Failed to start standalone worker', { error: err.message });
    process.exit(1);
  }
}

startStandaloneWorker();
