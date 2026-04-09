/**
 * Database migration runner with distributed locking.
 *
 * Uses advisory locks in PostgreSQL to prevent concurrent migrations.
 * This is critical in a multi-instance deployment where multiple
 * service instances might start simultaneously.
 */

import { Pool, PoolClient } from 'pg';
import { HIPAALogger } from '@meridian/hipaa-logger';
import * as fs from 'fs';
import * as path from 'path';

const logger = new HIPAALogger({ service: 'db-migrations' });

// Advisory lock ID for migration (arbitrary but unique within our system)
const MIGRATION_LOCK_ID = 8675309;

export interface MigrationFile {
  version: number;
  name: string;
  filePath: string;
}

export class MigrationRunner {
  private pool: Pool;
  private migrationsDir: string;

  constructor(pool: Pool, migrationsDir: string) {
    this.pool = pool;
    this.migrationsDir = migrationsDir;
  }

  /**
   * Run all pending migrations.
   * Uses an advisory lock to prevent concurrent execution.
   */
  async run(): Promise<{ applied: string[]; skipped: string[] }> {
    const client = await this.pool.connect();
    const applied: string[] = [];
    const skipped: string[] = [];

    try {
      // Acquire advisory lock
      const lockResult = await client.query(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [MIGRATION_LOCK_ID]
      );

      if (!lockResult.rows[0].acquired) {
        logger.info('Another instance is running migrations, skipping', {
          action: 'MIGRATION_LOCK_BUSY',
        });
        return { applied: [], skipped: ['all - lock held by another instance'] };
      }

      logger.info('Migration lock acquired, checking for pending migrations', {
        action: 'MIGRATION_LOCK_ACQUIRED',
      });

      // Ensure migrations table exists
      await this.ensureMigrationsTable(client);

      // Get list of applied migrations
      const appliedResult = await client.query(
        'SELECT version FROM migrations ORDER BY version'
      );
      const appliedVersions = new Set(
        appliedResult.rows.map((r: any) => r.version)
      );

      // Get migration files
      const migrationFiles = this.getMigrationFiles();

      // Apply pending migrations in order
      for (const migration of migrationFiles) {
        if (appliedVersions.has(migration.version)) {
          skipped.push(migration.name);
          continue;
        }

        logger.info(`Applying migration: ${migration.name}`, {
          action: 'MIGRATION_APPLY',
          version: migration.version,
          name: migration.name,
        });

        try {
          const sql = fs.readFileSync(migration.filePath, 'utf-8');

          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO migrations (version, name, applied_at) VALUES ($1, $2, NOW())',
            [migration.version, migration.name]
          );
          await client.query('COMMIT');

          applied.push(migration.name);

          logger.info(`Migration applied successfully: ${migration.name}`, {
            action: 'MIGRATION_APPLIED',
            version: migration.version,
          });
        } catch (error: any) {
          await client.query('ROLLBACK');

          logger.error(`Migration failed: ${migration.name}`, {
            action: 'MIGRATION_FAILED',
            version: migration.version,
            name: migration.name,
            error: error.message,
          });

          throw new Error(
            `Migration ${migration.name} failed: ${error.message}`
          );
        }
      }

      return { applied, skipped };
    } finally {
      // Release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      client.release();

      logger.info('Migration lock released', {
        action: 'MIGRATION_LOCK_RELEASED',
        applied: applied.length,
        skipped: skipped.length,
      });
    }
  }

  private async ensureMigrationsTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
  }

  private getMigrationFiles(): MigrationFile[] {
    if (!fs.existsSync(this.migrationsDir)) {
      return [];
    }

    return fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const match = f.match(/^(\d+)[_-](.+)\.sql$/);
        if (!match) return null;

        return {
          version: parseInt(match[1], 10),
          name: f,
          filePath: path.join(this.migrationsDir, f),
        };
      })
      .filter((f): f is MigrationFile => f !== null)
      .sort((a, b) => a.version - b.version);
  }
}

export async function runMigrations(pool: Pool, migrationsDir: string) {
  const runner = new MigrationRunner(pool, migrationsDir);
  return runner.run();
}
