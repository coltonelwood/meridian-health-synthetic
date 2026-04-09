import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import appointmentRoutes from './routes/appointments';
import availabilityRoutes from './routes/availability';
import { logger } from './utils/logger';
import { pool } from './db';

const app = express();
const PORT = process.env.SCHEDULING_SERVICE_PORT || 3002;

app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (e) { /* db down */ }

  res.json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'scheduling-service',
    version: process.env.npm_package_version || '3.2.1',
    uptime: process.uptime(),
  });
});

app.use('/api/v1/appointments', appointmentRoutes);
app.use('/api/v1/availability', availabilityRoutes);

// Legacy endpoint that some older integrations still hit
// TODO: add deprecation warning header and track usage
app.use('/api/schedule', appointmentRoutes);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
    },
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Scheduling service listening on port ${PORT}`);
  });
}

export default app;
