/**
 * Weekly Database Maintenance
 *
 * Performs routine database maintenance tasks:
 * - ANALYZE to update statistics for query planner
 * - REINDEX for heavily-updated indexes
 * - Check for table bloat
 * - Vacuum large tables
 * - Report on index usage and missing indexes
 *
 * Schedule: 0 1 * * 0 (1 AM ET, Sundays)
 * Timeout: 90 minutes
 * Owner: Platform Team (Tom Kowalski)
 */

import { CronJob } from '../lib/cron-job';
import { DatabasePool } from '../lib/database';
import { SlackNotifier } from '../lib/slack';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';

interface TableStats {
  tableName: string;
  rowCount: number;
  totalSize: string;
  tableSize: string;
  indexSize: string;
  bloatRatio: number;
  deadTuples: number;
  lastVacuum: string | null;
  lastAnalyze: string | null;
}

interface IndexUsageStats {
  tableName: string;
  indexName: string;
  indexSize: string;
  scans: number;
  tupleReads: number;
  tupleFetches: number;
}

// Tables that get heavy write traffic and need regular maintenance
const HIGH_WRITE_TABLES = [
  'audit_events',
  'claims',
  'claim_line_items',
  'appointments',
  'notifications',
  'api_metrics',
  'application_logs',
];

// Indexes to reindex due to high churn
const REINDEX_TARGETS = [
  'idx_audit_events_timestamp',
  'idx_claims_status',
  'idx_claims_service_date',
  'idx_appointments_start_time',
  'idx_notifications_status',
];

const BLOAT_THRESHOLD = 0.30; // Alert if any table has >30% bloat

const job = new CronJob({
  name: 'database-maintenance',
  schedule: '0 1 * * 0',
  timezone: 'America/New_York',
  timeout: 90 * 60 * 1000,
  retries: 0, // Don't retry maintenance - it could cause issues
});

job.run(async (context) => {
  const db = new DatabasePool('primary');
  const slack = new SlackNotifier('#platform-team');
  const startTime = Date.now();

  const results = {
    tablesAnalyzed: 0,
    indexesReindexed: 0,
    tablesVacuumed: 0,
    bloatedTables: [] as TableStats[],
    unusedIndexes: [] as IndexUsageStats[],
    missingIndexSuggestions: [] as string[],
    errors: [] as string[],
  };

  logger.info('Starting weekly database maintenance');

  try {
    // 1. Update table statistics (ANALYZE)
    logger.info('Phase 1: Updating table statistics');

    for (const table of HIGH_WRITE_TABLES) {
      try {
        const analyzeStart = Date.now();
        await db.query(`ANALYZE ${table}`);
        const duration = Date.now() - analyzeStart;

        results.tablesAnalyzed++;
        logger.info(`ANALYZE ${table} completed in ${duration}ms`);
        metrics.timing(`cron.db_maintenance.analyze.${table}`, duration);
      } catch (error) {
        const msg = `Failed to ANALYZE ${table}: ${error instanceof Error ? error.message : error}`;
        results.errors.push(msg);
        logger.error(msg);
      }
    }

    // 2. Reindex heavily-updated indexes
    logger.info('Phase 2: Reindexing');

    for (const indexName of REINDEX_TARGETS) {
      try {
        const reindexStart = Date.now();
        // REINDEX CONCURRENTLY to avoid locking
        await db.query(`REINDEX INDEX CONCURRENTLY ${indexName}`);
        const duration = Date.now() - reindexStart;

        results.indexesReindexed++;
        logger.info(`REINDEX ${indexName} completed in ${duration}ms`);
        metrics.timing(`cron.db_maintenance.reindex.${indexName}`, duration);
      } catch (error) {
        const msg = `Failed to REINDEX ${indexName}: ${error instanceof Error ? error.message : error}`;
        results.errors.push(msg);
        logger.error(msg);
        // Continue with other indexes
      }
    }

    // 3. Check table bloat
    logger.info('Phase 3: Checking table bloat');

    const bloatQuery = await db.query(`
      SELECT
        schemaname || '.' || tablename as table_name,
        pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as total_size,
        pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) as table_size,
        pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) as index_size,
        n_dead_tup as dead_tuples,
        n_live_tup as live_tuples,
        CASE WHEN n_live_tup > 0
          THEN ROUND(n_dead_tup::numeric / n_live_tup, 4)
          ELSE 0
        END as bloat_ratio,
        last_vacuum::text,
        last_analyze::text
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY n_dead_tup DESC
      LIMIT 20
    `);

    for (const row of bloatQuery.rows) {
      const stats: TableStats = {
        tableName: row.table_name,
        rowCount: row.live_tuples,
        totalSize: row.total_size,
        tableSize: row.table_size,
        indexSize: row.index_size,
        bloatRatio: parseFloat(row.bloat_ratio),
        deadTuples: row.dead_tuples,
        lastVacuum: row.last_vacuum,
        lastAnalyze: row.last_analyze,
      };

      if (stats.bloatRatio > BLOAT_THRESHOLD) {
        results.bloatedTables.push(stats);
        logger.warn(`Table ${stats.tableName} has ${(stats.bloatRatio * 100).toFixed(1)}% bloat (${stats.deadTuples} dead tuples)`);
      }
    }

    // 4. Vacuum bloated tables
    if (results.bloatedTables.length > 0) {
      logger.info(`Phase 4: Vacuuming ${results.bloatedTables.length} bloated tables`);

      for (const table of results.bloatedTables) {
        try {
          const vacuumStart = Date.now();
          // VACUUM (not VACUUM FULL) to avoid exclusive locks
          await db.query(`VACUUM (VERBOSE) ${table.tableName}`);
          const duration = Date.now() - vacuumStart;

          results.tablesVacuumed++;
          logger.info(`VACUUM ${table.tableName} completed in ${duration}ms`);
        } catch (error) {
          const msg = `Failed to VACUUM ${table.tableName}: ${error instanceof Error ? error.message : error}`;
          results.errors.push(msg);
          logger.error(msg);
        }
      }
    }

    // 5. Check for unused indexes
    logger.info('Phase 5: Checking index usage');

    const unusedIndexesQuery = await db.query(`
      SELECT
        schemaname || '.' || relname as table_name,
        indexrelname as index_name,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        idx_scan as scans,
        idx_tup_read as tuple_reads,
        idx_tup_fetch as tuple_fetches
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public'
        AND idx_scan = 0
        AND indexrelname NOT LIKE '%_pkey'
        AND indexrelname NOT LIKE '%_unique%'
        AND pg_relation_size(indexrelid) > 1024 * 1024  -- >1MB
      ORDER BY pg_relation_size(indexrelid) DESC
      LIMIT 10
    `);

    results.unusedIndexes = unusedIndexesQuery.rows.map((row: any) => ({
      tableName: row.table_name,
      indexName: row.index_name,
      indexSize: row.index_size,
      scans: row.scans,
      tupleReads: row.tuple_reads,
      tupleFetches: row.tuple_fetches,
    }));

    // 6. Check for missing indexes (sequential scans on large tables)
    const missingIndexQuery = await db.query(`
      SELECT
        schemaname || '.' || relname as table_name,
        seq_scan,
        seq_tup_read,
        idx_scan,
        CASE WHEN (seq_scan + idx_scan) > 0
          THEN ROUND(seq_scan::numeric / (seq_scan + idx_scan) * 100, 1)
          ELSE 0
        END as seq_scan_pct,
        n_live_tup
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
        AND n_live_tup > 10000
        AND seq_scan > idx_scan
        AND seq_scan > 100
      ORDER BY seq_tup_read DESC
      LIMIT 5
    `);

    for (const row of missingIndexQuery.rows) {
      results.missingIndexSuggestions.push(
        `${row.table_name}: ${row.seq_scan_pct}% sequential scans (${row.seq_scan} seq vs ${row.idx_scan} idx), ${row.n_live_tup} rows`
      );
    }

    // Send summary
    const totalDuration = Math.round((Date.now() - startTime) / 1000);

    let message = `*Weekly Database Maintenance Report*\n`;
    message += `Duration: ${totalDuration}s\n\n`;
    message += `Tables analyzed: ${results.tablesAnalyzed}\n`;
    message += `Indexes reindexed: ${results.indexesReindexed}\n`;
    message += `Tables vacuumed: ${results.tablesVacuumed}\n`;

    if (results.bloatedTables.length > 0) {
      message += `\n*Bloated Tables (>${BLOAT_THRESHOLD * 100}%):*\n`;
      for (const t of results.bloatedTables) {
        message += `- \`${t.tableName}\`: ${(t.bloatRatio * 100).toFixed(1)}% bloat, ${t.deadTuples} dead tuples\n`;
      }
    }

    if (results.unusedIndexes.length > 0) {
      message += `\n*Unused Indexes (consider dropping):*\n`;
      for (const idx of results.unusedIndexes) {
        message += `- \`${idx.indexName}\` on ${idx.tableName} (${idx.indexSize}, 0 scans)\n`;
      }
    }

    if (results.missingIndexSuggestions.length > 0) {
      message += `\n*Potential Missing Indexes:*\n`;
      for (const suggestion of results.missingIndexSuggestions) {
        message += `- ${suggestion}\n`;
      }
    }

    if (results.errors.length > 0) {
      message += `\n*Errors (${results.errors.length}):*\n`;
      for (const error of results.errors) {
        message += `- ${error}\n`;
      }
    }

    await slack.send(message);

    metrics.gauge('cron.db_maintenance.tables_analyzed', results.tablesAnalyzed);
    metrics.gauge('cron.db_maintenance.indexes_reindexed', results.indexesReindexed);
    metrics.gauge('cron.db_maintenance.tables_vacuumed', results.tablesVacuumed);
    metrics.gauge('cron.db_maintenance.bloated_tables', results.bloatedTables.length);
    metrics.gauge('cron.db_maintenance.unused_indexes', results.unusedIndexes.length);
    metrics.gauge('cron.db_maintenance.errors', results.errors.length);
    metrics.timing('cron.db_maintenance.duration', Date.now() - startTime);

    logger.info('Database maintenance complete', results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Database maintenance failed: ${errorMessage}`);
    await slack.sendUrgent(`Database maintenance FAILED: ${errorMessage}`);
    throw error;
  } finally {
    await db.end();
  }
});

export default job;
