import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import winston from 'winston';

import invoiceRoutes from './routes/invoices';
import paymentRoutes from './routes/payments';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3007;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'billing' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json()
    }),
  ],
});

// Database pool
const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'meridian',
  password: process.env.DB_PASSWORD || 'meridian_dev',
  database: process.env.DB_NAME || 'billing_db',
  max: parseInt(process.env.DB_POOL_SIZE || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

(global as any).__pgPool = pgPool;
(global as any).__logger = logger;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
}));
app.use(compression());

// IMPORTANT: Stripe webhooks need raw body for signature verification
// This is why we DON'T use express.json() globally - the webhook endpoint
// needs the raw buffer. Instead we apply json parsing per-route.
// See payments.ts for the webhook-specific body parsing.
app.use('/api', express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) }
  }));
}

// Health check
app.get('/health', async (req, res) => {
  try {
    await pgPool.query('SELECT 1');
    res.json({
      status: 'healthy',
      version: '3.2.1',
      uptime: process.uptime(),
      stripe_configured: !!process.env.STRIPE_SECRET_KEY,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
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
app.use('/api/v1/invoices', invoiceRoutes);
app.use('/api/v1/payments', paymentRoutes);

// Stripe webhook endpoint - raw body handling
// Has to be mounted separately because of the raw body requirement
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), paymentRoutes);

// 404
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error in billing service', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Never expose financial details in error responses
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An error occurred processing your request'
      : err.message,
    requestId: (req as any).requestId,
  });
});

const start = async () => {
  try {
    await pgPool.query('SELECT 1');
    logger.info('Database connected');

    if (!process.env.STRIPE_SECRET_KEY) {
      logger.warn('STRIPE_SECRET_KEY not configured - payment processing will fail');
      // Don't exit - we can still serve invoice data without Stripe
    }

    app.listen(PORT, () => {
      logger.info(`Billing service started on port ${PORT}`, {
        environment: process.env.NODE_ENV,
      });
    });
  } catch (error: any) {
    logger.error('Failed to start billing service', { error: error.message });
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection in billing service', { reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception in billing service', { error: error.message, stack: error.stack });
  setTimeout(() => process.exit(1), 1000);
});

start();

export default app;
