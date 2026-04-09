/**
 * Test database setup and teardown utilities.
 *
 * Creates a temporary test database, runs migrations, and provides
 * cleanup between tests. Each test suite gets its own database to
 * prevent test pollution.
 *
 * Usage:
 * ```
 * import { setupTestDb } from '@meridian/test-helpers';
 *
 * describe('MyService', () => {
 *   const db = setupTestDb();
 *
 *   it('should do something', async () => {
 *     await db.query('INSERT INTO patients ...');
 *   });
 * });
 * ```
 *
 * Requires:
 * - PostgreSQL running on localhost:5433 (test port)
 * - Or set DATABASE_URL environment variable
 */

import { Pool } from 'pg';

const TEST_DB_PREFIX = 'meridian_test_';

export interface TestDatabase {
  pool: Pool;
  databaseName: string;
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
  close: () => Promise<void>;
}

/**
 * Set up a test database. Call in beforeAll.
 * Returns a database connection and cleanup function.
 */
export async function setupTestDb(): Promise<TestDatabase> {
  const adminPool = new Pool({
    host: process.env.TEST_DB_HOST || 'localhost',
    port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
    database: 'postgres',
    user: process.env.TEST_DB_USER || 'meridian',
    password: process.env.TEST_DB_PASSWORD || 'test_password',
  });

  // Create a unique database name for this test run
  const dbName = `${TEST_DB_PREFIX}${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } catch (error: any) {
    await adminPool.end();
    throw new Error(`Failed to create test database: ${error.message}`);
  }

  await adminPool.end();

  // Connect to the new test database
  const testPool = new Pool({
    host: process.env.TEST_DB_HOST || 'localhost',
    port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
    database: dbName,
    user: process.env.TEST_DB_USER || 'meridian',
    password: process.env.TEST_DB_PASSWORD || 'test_password',
  });

  // Run migrations on the test database
  // In a real setup, this would use the MigrationRunner
  await runTestMigrations(testPool);

  return {
    pool: testPool,
    databaseName: dbName,
    async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
      return testPool.query<T>(sql, params);
    },
    async close(): Promise<void> {
      await testPool.end();

      // Drop the test database
      const cleanupPool = new Pool({
        host: process.env.TEST_DB_HOST || 'localhost',
        port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
        database: 'postgres',
        user: process.env.TEST_DB_USER || 'meridian',
        password: process.env.TEST_DB_PASSWORD || 'test_password',
      });

      try {
        // Force disconnect all clients
        await cleanupPool.query(`
          SELECT pg_terminate_backend(pg_stat_activity.pid)
          FROM pg_stat_activity
          WHERE pg_stat_activity.datname = '${dbName}'
          AND pid <> pg_backend_pid()
        `);
        await cleanupPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await cleanupPool.end();
      }
    },
  };
}

/**
 * Clean all test data from tables without dropping the schema.
 * Use between tests for isolation.
 */
export async function cleanTestData(pool: Pool): Promise<void> {
  const tables = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename != 'migrations'
  `);

  if (tables.rows.length > 0) {
    const tableNames = tables.rows.map((r: any) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${tableNames} CASCADE`);
  }
}

/**
 * Tear down test database. Call in afterAll.
 */
export async function teardownTestDb(db: TestDatabase): Promise<void> {
  await db.close();
}

// --- Private -----------------------------------------------------------------

async function runTestMigrations(pool: Pool): Promise<void> {
  // Create the basic schema for testing
  // In a real setup, this would use the actual migration files
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mrn VARCHAR(20) UNIQUE NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      date_of_birth DATE NOT NULL,
      gender VARCHAR(10),
      email VARCHAR(255),
      phone VARCHAR(20),
      status VARCHAR(20) DEFAULT 'active',
      insurance_status VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS providers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      npi VARCHAR(10) UNIQUE NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      specialty_code VARCHAR(20),
      credentialing_status VARCHAR(20) DEFAULT 'pending',
      accepting_new_patients BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS claims (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      claim_number VARCHAR(30) UNIQUE NOT NULL,
      patient_id UUID REFERENCES patients(id),
      provider_id UUID REFERENCES providers(id),
      claim_type VARCHAR(10) NOT NULL,
      total_charge INTEGER NOT NULL,
      status VARCHAR(30) DEFAULT 'pending',
      payer_id VARCHAR(20),
      subscriber_id VARCHAR(30),
      tracking_number VARCHAR(50),
      submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id UUID REFERENCES patients(id),
      provider_id UUID REFERENCES providers(id),
      date_time TIMESTAMPTZ NOT NULL,
      duration INTEGER NOT NULL,
      type VARCHAR(30),
      status VARCHAR(20) DEFAULT 'scheduled',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id VARCHAR(20) PRIMARY KEY,
      patient_id UUID REFERENCES patients(id),
      referring_provider_id UUID REFERENCES providers(id),
      referred_to_provider_id UUID REFERENCES providers(id),
      specialty_code VARCHAR(20),
      urgency VARCHAR(20),
      status VARCHAR(20) DEFAULT 'active',
      number_of_visits INTEGER,
      visits_completed INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      level VARCHAR(10),
      service VARCHAR(50),
      action VARCHAR(50),
      user_id VARCHAR(50),
      patient_id VARCHAR(50),
      resource VARCHAR(50),
      resource_id VARCHAR(50),
      metadata JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_patients_mrn ON patients(mrn);
    CREATE INDEX IF NOT EXISTS idx_claims_patient ON claims(patient_id);
    CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
    CREATE INDEX IF NOT EXISTS idx_audit_patient ON audit_log(patient_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  `);
}
