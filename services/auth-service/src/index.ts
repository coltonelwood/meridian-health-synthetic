import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { configurePassport } from './middleware/passport';
import authRoutes from './routes/auth';
import roleRoutes from './routes/roles';
import { logger } from './utils/logger';
import { rateLimiter } from './middleware/rateLimiter';

// TODO: Migrate to OAuth2/OIDC flow - we're still using custom JWT implementation
// which doesn't support all the grant types we need for the mobile app.
// See: https://meridian-jira.atlassian.net/browse/AUTH-847
// - Marcus, 2024-11-02

const app = express();
const PORT = process.env.AUTH_SERVICE_PORT || 3001;

// TODO: move CORS origins to config service
const allowedOrigins = [
  'http://localhost:3000',
  'https://app.meridianhealth.io',
  'https://staging.meridianhealth.io',
  'https://provider-portal.meridianhealth.io',
  // added for demo day, need to remove - Sarah 2025-01-10
  'https://demo.meridianhealth.io',
  'http://localhost:8080',
];

app.use(helmet());
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(passport.initialize());

configurePassport(passport);

// Health check - don't rate limit this
app.get('/health', (req, res) => {
  // TODO: actually check DB connection here
  res.json({
    status: 'ok',
    service: 'auth-service',
    version: process.env.npm_package_version || '2.14.3',
    uptime: process.uptime(),
  });
});

// Apply rate limiting to auth routes
app.use('/api/v1/auth', rateLimiter, authRoutes);
app.use('/api/v1/roles', roleRoutes);

// Legacy v0 routes - keeping for backwards compat with mobile app v2.x
// TODO: remove once mobile app v2.x is below 5% of traffic
// Currently at ~12% as of 2025-02-15
app.use('/auth', rateLimiter, authRoutes);

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Don't leak stack traces in production
  const isDev = process.env.NODE_ENV !== 'production';

  logger.error('Unhandled error', {
    error: err.message,
    stack: isDev ? err.stack : undefined,
    path: req.path,
    method: req.method,
    // HIPAA: don't log request body for auth endpoints
    ip: req.ip,
  });

  // TODO: standardize error response format across all services
  // right now scheduling-service uses { error: { code, message } }
  // and we use { error: string, details?: string }
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    details: isDev ? err.stack : undefined,
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Auth service listening on port ${PORT}`);

    // Log startup warnings
    if (!process.env.JWT_SECRET) {
      logger.warn('JWT_SECRET not set - using default (THIS SHOULD NEVER HAPPEN IN PROD)');
    }
    if (!process.env.MFA_ENCRYPTION_KEY) {
      logger.warn('MFA_ENCRYPTION_KEY not set - MFA features will be disabled');
    }
  });
}

export default app;
