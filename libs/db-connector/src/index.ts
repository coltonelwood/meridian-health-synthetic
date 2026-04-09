/**
 * @meridian/db-connector
 *
 * Database connection factory for Meridian Health services.
 * Creates and manages PostgreSQL connection pools with:
 * - Automatic retry with exponential backoff on connection failure
 * - Connection pool configuration optimized for healthcare workloads
 * - SSL/TLS enforcement (HIPAA requirement)
 * - Query timeout protection
 * - Connection lifecycle hooks for monitoring
 */

import { Pool, PoolConfig, PoolClient, QueryResult } from 'pg';
import { HIPAALogger } from '@meridian/hipaa-logger';

const logger = new HIPAALogger({ service: 'db-connector' });

// --- Types -------------------------------------------------------------------

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  poolMin?: number;
  poolMax?: number;
  idleTimeout?: number;  // ms
  connectionTimeout?: number;  // ms
  statementTimeout?: number;  // ms
  applicationName?: string;
  // Read replica for read-only queries
  readReplicaHost?: string;
}

export interface DatabaseConnection {
  query: <T = any>(sql: string, params?: any[]) => Promise<QueryResult<T>>;
  getClient: () => Promise<PoolClient>;
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  healthCheck: () => Promise<boolean>;
  close: () => Promise<void>;
  // Read-only connection (uses replica if available)
  readonly: {
    query: <T = any>(sql: string, params?: any[]) => Promise<QueryResult<T>>;
  };
}

// --- Connection Factory ------------------------------------------------------

/**
 * Create a database connection with automatic retry and health monitoring.
 */
export async function createConnection(config: DatabaseConfig): Promise<DatabaseConnection> {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    min: config.poolMin || 5,
    max: config.poolMax || 20,
    idleTimeoutMillis: config.idleTimeout || 30000,
    connectionTimeoutMillis: config.connectionTimeout || 10000,
    application_name: config.applicationName || 'meridian-service',
    // Statement timeout - prevent runaway queries
    statement_timeout: config.statementTimeout || 300000, // 5 min default
  };

  // SSL is required in all environments except local development
  if (config.ssl !== false) {
    poolConfig.ssl = {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    };
  }

  const primaryPool = new Pool(poolConfig);

  // Create a separate read replica pool if configured
  let replicaPool: Pool | null = null;
  if (config.readReplicaHost) {
    replicaPool = new Pool({
      ...poolConfig,
      host: config.readReplicaHost,
    });
  }

  // Connect with retry
  await connectWithRetry(primaryPool, config.host);

  // Monitor pool events
  primaryPool.on('error', (err) => {
    logger.error('Unexpected database pool error', {
      action: 'DB_POOL_ERROR',
      host: config.host,
      error: err.message,
    });
  });

  primaryPool.on('connect', () => {
    logger.debug('New database connection established', {
      action: 'DB_CONNECT',
      host: config.host,
      totalCount: primaryPool.totalCount,
      idleCount: primaryPool.idleCount,
      waitingCount: primaryPool.waitingCount,
    });
  });

  // Build the connection interface
  const connection: DatabaseConnection = {
    async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
      const start = Date.now();
      try {
        const result = await primaryPool.query<T>(sql, params);
        const duration = Date.now() - start;

        if (duration > 5000) {
          logger.warn('Slow query detected', {
            action: 'DB_SLOW_QUERY',
            duration,
            // Don't log the SQL or params - they might contain PHI
            queryLength: sql.length,
          });
        }

        return result;
      } catch (error: any) {
        const duration = Date.now() - start;
        logger.error('Database query error', {
          action: 'DB_QUERY_ERROR',
          duration,
          errorCode: error.code,
          errorMessage: error.message,
          // Don't log SQL or params
        });
        throw error;
      }
    },

    async getClient(): Promise<PoolClient> {
      return primaryPool.connect();
    },

    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await primaryPool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const result = await primaryPool.query('SELECT 1 as healthy');
        return result.rows[0]?.healthy === 1;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await primaryPool.end();
      if (replicaPool) {
        await replicaPool.end();
      }
    },

    readonly: {
      async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
        const pool = replicaPool || primaryPool;
        return pool.query<T>(sql, params);
      },
    },
  };

  return connection;
}

// --- Retry Logic -------------------------------------------------------------

async function connectWithRetry(pool: Pool, host: string, maxRetries: number = 5): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      client.release();

      logger.info('Database connection established', {
        action: 'DB_CONNECTED',
        host,
        attempt,
      });

      return;
    } catch (error: any) {
      lastError = error;

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // exponential backoff, max 30s

      logger.warn(`Database connection attempt ${attempt}/${maxRetries} failed`, {
        action: 'DB_CONNECT_RETRY',
        host,
        attempt,
        maxRetries,
        nextRetryMs: delay,
        error: error.message,
      });

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.error('Database connection failed after all retries', {
    action: 'DB_CONNECT_FAILED',
    host,
    maxRetries,
    error: lastError?.message,
  });

  throw new Error(`Failed to connect to database at ${host} after ${maxRetries} attempts: ${lastError?.message}`);
}

// Re-export utilities
export { runMigrations, MigrationRunner } from './migrations';
export { checkDatabaseHealth, DatabaseHealthStatus } from './health';
