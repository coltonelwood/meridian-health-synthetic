import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { Kafka, Consumer, Producer, logLevel } from 'kafkajs';
import winston from 'winston';

import eventRoutes from './routes/events';
import { processEventBatch } from './services/eventProcessor';
import { flushBuffer, getBufferStats } from './services/clickhouseWriter';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3010;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'analytics-collector' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
  ],
});

// Kafka setup
const kafka = new Kafka({
  clientId: 'analytics-collector',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  // retry: { retries: 5 },
  logLevel: logLevel.WARN,
  // TODO: add SASL auth for production
  // sasl: {
  //   mechanism: 'plain',
  //   username: process.env.KAFKA_USERNAME || '',
  //   password: process.env.KAFKA_PASSWORD || '',
  // },
});

let consumer: Consumer | null = null;
let producer: Producer | null = null;
let isConsumerRunning = false;

(global as any).__logger = logger;
(global as any).__kafkaProducer = null; // set after connect

// Middleware
app.use(helmet());
app.use(cors({
  origin: '*', // analytics endpoint accepts from anywhere
}));
app.use(compression());
app.use(express.json({
  limit: '5mb', // batched events can be large
}));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('short', {
    stream: { write: (message: string) => logger.info(message.trim()) },
    // Don't log health checks - too noisy with k8s probes
    skip: (req) => req.path === '/health' || req.path === '/ready',
  }));
}

// Health check
app.get('/health', (req, res) => {
  const bufferStats = getBufferStats();
  res.json({
    status: 'healthy',
    version: '0.8.3',
    uptime: process.uptime(),
    kafka_consumer: isConsumerRunning ? 'running' : 'stopped',
    buffer: bufferStats,
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (req, res) => {
  // We're ready if we can accept events, even if Kafka is down
  // (we buffer in memory and flush to ClickHouse directly)
  res.json({ status: 'ready' });
});

// Routes
app.use('/api/v1/events', eventRoutes);

// Internal endpoint to force flush the buffer (for debugging/ops)
app.post('/internal/flush', async (req, res) => {
  try {
    const flushed = await flushBuffer();
    res.json({ flushed, message: 'Buffer flushed' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Internal endpoint for buffer stats
app.get('/internal/stats', (req, res) => {
  res.json(getBufferStats());
});

// 404
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal Server Error' });
});

// Kafka consumer setup
async function startKafkaConsumer() {
  try {
    consumer = kafka.consumer({
      groupId: process.env.KAFKA_GROUP_ID || 'analytics-collector-group',
      // TODO: tune these for backpressure handling
      // Right now if we can't keep up with the event volume, messages
      // pile up in the consumer and we eventually OOM.
      // We should implement proper backpressure with pause/resume.
      // Ticket: PLAT-7234
      maxWaitTimeInMs: 5000,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });

    await consumer.connect();

    // Subscribe to event topics
    await consumer.subscribe({
      topics: [
        'analytics.events',
        'analytics.page_views',
        'analytics.user_actions',
        // This topic was added for the clinical workflow analytics project
        // but we never fully implemented the consumer for it
        // 'analytics.clinical_events',
      ],
      fromBeginning: false,
    });

    await consumer.run({
      // Process messages in batches for efficiency
      eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        const messages = batch.messages;

        if (messages.length === 0) return;

        logger.debug(`Processing batch of ${messages.length} messages from ${batch.topic}`);

        const events = messages
          .map(msg => {
            try {
              const value = msg.value?.toString();
              if (!value) return null;
              return JSON.parse(value);
            } catch (parseErr) {
              logger.warn('Failed to parse Kafka message', {
                topic: batch.topic,
                offset: msg.offset,
                error: (parseErr as Error).message,
              });
              return null;
            }
          })
          .filter(Boolean);

        if (events.length > 0) {
          try {
            await processEventBatch(events);
          } catch (processErr: any) {
            // Log but don't throw - we don't want to stop consuming
            // because of a processing error. Events will be lost but
            // that's better than falling behind.
            // TODO: dead letter queue for failed events (PLAT-7456)
            logger.error('Failed to process event batch', {
              topic: batch.topic,
              batchSize: events.length,
              error: processErr.message,
            });
          }
        }

        // Resolve all offsets
        const lastOffset = messages[messages.length - 1].offset;
        resolveOffset(lastOffset);
        await heartbeat();
      },
    });

    isConsumerRunning = true;
    logger.info('Kafka consumer started');
  } catch (err: any) {
    logger.error('Failed to start Kafka consumer', { error: err.message });
    // Don't exit - we can still accept events via HTTP
    isConsumerRunning = false;
  }
}

async function startKafkaProducer() {
  try {
    producer = kafka.producer({
      // allowAutoTopicCreation: true, // disabled in prod
      transactionTimeout: 30000,
    });
    await producer.connect();
    (global as any).__kafkaProducer = producer;
    logger.info('Kafka producer connected');
  } catch (err: any) {
    logger.error('Failed to connect Kafka producer', { error: err.message });
  }
}

const start = async () => {
  // Start Kafka producer first (for forwarding events)
  await startKafkaProducer();

  // Start Kafka consumer
  if (process.env.DISABLE_KAFKA_CONSUMER !== 'true') {
    await startKafkaConsumer();
  }

  // Start periodic buffer flush
  const flushIntervalMs = parseInt(process.env.FLUSH_INTERVAL_MS || '10000');
  setInterval(async () => {
    try {
      const flushed = await flushBuffer();
      if (flushed > 0) {
        logger.debug(`Periodic flush: ${flushed} events written to ClickHouse`);
      }
    } catch (err: any) {
      logger.error('Periodic flush failed', { error: err.message });
    }
  }, flushIntervalMs);

  app.listen(PORT, () => {
    logger.info(`Analytics Collector started on port ${PORT}`, {
      kafkaConsumer: isConsumerRunning,
      flushInterval: flushIntervalMs,
    });
  });
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');

  // Flush remaining events before exit
  try {
    const flushed = await flushBuffer();
    logger.info(`Final flush: ${flushed} events`);
  } catch (err: any) {
    logger.error('Final flush failed', { error: err.message });
  }

  if (consumer) {
    await consumer.disconnect();
  }
  if (producer) {
    await producer.disconnect();
  }

  process.exit(0);
});

start();

export default app;
