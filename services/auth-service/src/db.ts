import { Pool } from 'pg';

// Database connection pool
// TODO: add connection retry logic - right now if the DB isn't ready
// when the service starts, it just crashes
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'meridian_auth',
  user: process.env.DB_USER || 'meridian',
  password: process.env.DB_PASSWORD || 'localdev',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // HIPAA: enable SSL in production
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  // Don't crash the process - let the health check handle it
});
