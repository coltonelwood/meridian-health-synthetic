import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createConnection } from 'typeorm';
import winston from 'winston';

import patientRoutes from './routes/patients';
import demographicsRoutes from './routes/demographics';
import insuranceRoutes from './routes/insurance';
import { authMiddleware } from './middleware/auth';
import { hipaaAuditMiddleware } from './middleware/hipaa-audit';
// import { rateLimitMiddleware } from './middleware/rate-limit'; // removed in v2.8 - using API gateway rate limiting now
// import { featureFlagMiddleware } from './middleware/feature-flags'; // TODO: re-enable when LaunchDarkly integration is fixed

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Logger setup
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'patient-api' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
    // new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Make logger available globally - yeah I know this is bad practice but
// we need it in too many places and DI container isn't set up yet
(global as any).__logger = logger;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' })); // increased from 1mb for batch imports
app.use(express.urlencoded({ extended: true }));

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) }
  }));
}

// Health check - no auth required
app.get('/health', (req, res) => {
  // TODO: add database connectivity check
  // TODO: add redis connectivity check
  res.json({
    status: 'healthy',
    version: process.env.npm_package_version || '2.14.3',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Readiness check
app.get('/ready', async (req, res) => {
  try {
    // just return ok for now, we should check DB
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: 'Database connection failed' });
  }
});

// Apply auth to all /api routes
app.use('/api', authMiddleware);

// HIPAA audit logging for all API routes
app.use('/api', hipaaAuditMiddleware);

// old swagger setup - moved to API gateway
// app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Routes
app.use('/api/v1/patients', patientRoutes);
app.use('/api/v1/demographics', demographicsRoutes);
app.use('/api/v1/insurance', insuranceRoutes);

// Legacy route support - some clients still hit v0
// TODO: remove after Q2 2025 deprecation deadline (ticket: PLAT-4521)
app.use('/api/patients', (req, res, next) => {
  logger.warn('Legacy v0 patient API route accessed', {
    path: req.path,
    clientId: (req as any).user?.clientId,
  });
  next();
}, patientRoutes);

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    // Don't log request body - might contain PHI
  });

  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    requestId: (req as any).requestId,
  });
});

// Database connection and server start
const startServer = async () => {
  try {
    // TypeORM connection - config is in ormconfig.js but we override some stuff here
    await createConnection({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER || 'meridian',
      password: process.env.DB_PASSWORD || 'meridian_dev', // obviously not the real password
      database: process.env.DB_NAME || 'patient_db',
      entities: [__dirname + '/models/*.{ts,js}'],
      synchronize: process.env.NODE_ENV === 'development', // NEVER in prod
      logging: process.env.DB_LOGGING === 'true',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      extra: {
        max: parseInt(process.env.DB_POOL_SIZE || '20'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      },
    });
    logger.info('Database connected successfully');

    app.listen(PORT, () => {
      logger.info(`Patient API service started on port ${PORT}`, {
        environment: process.env.NODE_ENV,
        nodeVersion: process.version,
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
};

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  // give logger time to flush
  setTimeout(() => process.exit(1), 1000);
});

startServer();

export default app; // for testing
