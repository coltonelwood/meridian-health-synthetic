import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import winston from 'winston';

import fhirRoutes from './routes/fhir';
import bulkExportRoutes from './routes/bulk-export';
import { getCapabilityStatement } from './services/capabilityStatement';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3011;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'fhir-gateway' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
  ],
});

// Database pool (for resource ID mapping)
const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'meridian',
  password: process.env.DB_PASSWORD || 'meridian_dev',
  database: process.env.DB_NAME || 'fhir_gateway',
  max: parseInt(process.env.DB_POOL_SIZE || '10'),
  idleTimeoutMillis: 30000,
});

(global as any).__pgPool = pgPool;
(global as any).__logger = logger;

// FHIR-specific middleware
// FHIR servers must support both application/fhir+json and application/json
app.use(helmet({
  // Relax CSP for FHIR - some clients send unusual content types
  contentSecurityPolicy: false,
}));
app.use(cors({
  origin: '*', // FHIR endpoints are typically open (auth handled by SMART on FHIR)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Prefer', 'If-Match', 'If-None-Match'],
  exposedHeaders: ['ETag', 'Location', 'Content-Location', 'Last-Modified'],
}));
app.use(compression());

// FHIR content type handling
// Accept both application/fhir+json and application/json
app.use((req, res, next) => {
  // Set FHIR content type on response
  const accept = req.headers.accept || '';
  if (accept.includes('application/fhir+json') || req.path.startsWith('/fhir')) {
    res.setHeader('Content-Type', 'application/fhir+json; charset=utf-8');
  }

  // Parse JSON body regardless of content type
  // Some FHIR clients send application/fhir+json which express.json()
  // doesn't recognize by default
  if (req.headers['content-type']?.includes('fhir+json')) {
    req.headers['content-type'] = 'application/json';
  }

  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) }
  }));
}

// FHIR conformance/capability statement (metadata endpoint)
// This is required by the FHIR spec - clients use it to discover server capabilities
app.get('/fhir/metadata', (req, res) => {
  const capabilityStatement = getCapabilityStatement(req);
  res.json(capabilityStatement);
});

// Also support the older DSTU2 "conformance" path that some EHRs still use
app.get('/fhir/Conformance', (req, res) => {
  logger.warn('Legacy DSTU2 Conformance endpoint accessed', {
    client: req.headers['user-agent'],
  });
  const capabilityStatement = getCapabilityStatement(req);
  res.json(capabilityStatement);
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pgPool.query('SELECT 1');
    res.json({
      status: 'healthy',
      version: '1.3.0',
      fhir_version: '4.0.1',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
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

// FHIR resource routes
app.use('/fhir', fhirRoutes);

// Bulk export routes (FHIR Bulk Data Access)
app.use('/fhir', bulkExportRoutes);

// FHIR-compliant error responses
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code: 'not-found',
      diagnostics: `No route for ${req.method} ${req.path}`,
    }],
  });
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('FHIR Gateway error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  // FHIR spec requires OperationOutcome for errors
  res.status(err.status || 500).json({
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code: err.fhirCode || 'exception',
      diagnostics: process.env.NODE_ENV === 'production'
        ? 'An internal error occurred'
        : err.message,
    }],
  });
});

const start = async () => {
  try {
    await pgPool.query('SELECT 1');
    logger.info('Database connected');

    // Verify internal API endpoints are reachable
    // We proxy to patient-api, scheduling, etc.
    const internalApiBase = process.env.INTERNAL_API_BASE || 'http://localhost:3001';
    logger.info('Internal API base URL', { url: internalApiBase });
    // TODO: actually ping the internal APIs to verify connectivity

    app.listen(PORT, () => {
      logger.info(`FHIR Gateway started on port ${PORT}`, {
        fhirVersion: 'R4 (4.0.1)',
        basePath: '/fhir',
      });
    });
  } catch (error: any) {
    logger.error('Failed to start FHIR Gateway', { error: error.message });
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
});

start();

export default app;
