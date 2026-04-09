import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { Pool } from 'pg';
import winston from 'winston';

import providerRoutes from './routes/providers';
import specialtyRoutes from './routes/specialties';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3006;

// Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'provider-directory' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
  ],
});

// Elasticsearch client
// NOTE: We had to downgrade from v8.12 to v8.11 because of a breaking change
// in the bulk helper API. See PLAT-5102.
const esClient = new ElasticsearchClient({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  auth: process.env.ES_USERNAME ? {
    username: process.env.ES_USERNAME,
    password: process.env.ES_PASSWORD || '',
  } : undefined,
  // TODO: enable TLS in production
  // tls: { rejectUnauthorized: false },
  maxRetries: 3,
  requestTimeout: 30000,
  // sniffOnStart: true, // disabled - was causing issues in k8s with internal DNS
});

// Postgres pool
const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'meridian',
  password: process.env.DB_PASSWORD || 'meridian_dev',
  database: process.env.DB_NAME || 'provider_directory',
  max: parseInt(process.env.DB_POOL_SIZE || '15'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Make clients available on app
app.set('esClient', esClient);
app.set('pgPool', pgPool);
app.set('logger', logger);
// also dump on global because some service files need it and I don't
// want to refactor the whole thing right now
(global as any).__esClient = esClient;
(global as any).__pgPool = pgPool;
(global as any).__logger = logger;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) }
  }));
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const esHealth = await esClient.cluster.health();
    const dbResult = await pgPool.query('SELECT 1');
    res.json({
      status: 'healthy',
      version: '1.9.7',
      uptime: process.uptime(),
      elasticsearch: esHealth.status,
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    // still return 200 if ES is down - we can serve from postgres
    // this is a deliberate choice, not a bug (see incident 2024-11-03)
    logger.warn('Health check partial failure', { error: err.message });
    res.json({
      status: 'degraded',
      version: '1.9.7',
      uptime: process.uptime(),
      elasticsearch: 'unavailable',
      database: 'unknown',
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/ready', async (req, res) => {
  try {
    await pgPool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

// Routes
app.use('/api/v1/providers', providerRoutes);
app.use('/api/v1/specialties', specialtyRoutes);

// Legacy routes - old mobile app still uses these
// TODO: add deprecation headers and track usage (PLAT-6201)
app.use('/api/providers', providerRoutes);
app.use('/api/specialties', specialtyRoutes);

// 404
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error in provider-directory', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    requestId: (req as any).requestId,
  });
});

const start = async () => {
  try {
    // verify ES index exists, create if not
    const indexExists = await esClient.indices.exists({ index: 'providers' });
    if (!indexExists) {
      logger.info('Creating providers index in Elasticsearch');
      await esClient.indices.create({
        index: 'providers',
        body: {
          settings: {
            number_of_shards: 2,
            number_of_replicas: 1,
            analysis: {
              analyzer: {
                provider_name_analyzer: {
                  type: 'custom',
                  tokenizer: 'standard',
                  filter: ['lowercase', 'asciifolding', 'edge_ngram_filter'],
                },
              },
              filter: {
                edge_ngram_filter: {
                  type: 'edge_ngram',
                  min_gram: 2,
                  max_gram: 15,
                },
              },
            },
          },
          mappings: {
            properties: {
              npi: { type: 'keyword' },
              first_name: { type: 'text', analyzer: 'provider_name_analyzer' },
              last_name: { type: 'text', analyzer: 'provider_name_analyzer' },
              specialty: { type: 'keyword' },
              taxonomy_code: { type: 'keyword' },
              location: { type: 'geo_point' },
              accepting_new_patients: { type: 'boolean' },
              network_ids: { type: 'keyword' },
              languages: { type: 'keyword' },
              gender: { type: 'keyword' },
              rating: { type: 'float' },
              // full text for "find me a doctor who does X" searches
              bio: { type: 'text' },
              credentials: { type: 'keyword' },
            },
          },
        },
      });
    }

    app.listen(PORT, () => {
      logger.info(`Provider Directory service started on port ${PORT}`);
    });
  } catch (error: any) {
    logger.error('Failed to start provider-directory', { error: error.message });
    // if ES is down, start anyway - we can fall back to postgres
    if (error.message?.includes('connect ECONNREFUSED') || error.name === 'ConnectionError') {
      logger.warn('Starting without Elasticsearch - search will use postgres fallback');
      app.listen(PORT, () => {
        logger.info(`Provider Directory service started on port ${PORT} (degraded mode)`);
      });
    } else {
      process.exit(1);
    }
  }
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await pgPool.end();
  await esClient.close();
  process.exit(0);
});

start();

export default app;
