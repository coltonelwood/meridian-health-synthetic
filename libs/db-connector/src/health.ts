/**
 * Database health check utilities.
 * Used by service health endpoints to report database status.
 */

import { Pool } from 'pg';

export interface DatabaseHealthStatus {
  healthy: boolean;
  latencyMs: number;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  waitingClients: number;
  replicationLagMs?: number;
  error?: string;
}

export async function checkDatabaseHealth(
  pool: Pool,
  replicaPool?: Pool | null
): Promise<DatabaseHealthStatus> {
  const start = Date.now();

  try {
    // Basic connectivity check
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - start;

    const status: DatabaseHealthStatus = {
      healthy: true,
      latencyMs,
      poolSize: pool.totalCount,
      activeConnections: pool.totalCount - pool.idleCount,
      idleConnections: pool.idleCount,
      waitingClients: pool.waitingCount,
    };

    // Check replication lag if replica pool exists
    if (replicaPool) {
      try {
        const lagResult = await pool.query(`
          SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 as lag_ms
        `);
        status.replicationLagMs = lagResult.rows[0]?.lag_ms || 0;
      } catch {
        // Replication lag query might fail if not a replica
        status.replicationLagMs = undefined;
      }
    }

    // Warn if pool is nearly exhausted
    if (status.waitingClients > 0) {
      status.healthy = false;
      status.error = `${status.waitingClients} clients waiting for connections`;
    }

    return status;
  } catch (error: any) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      poolSize: pool.totalCount,
      activeConnections: pool.totalCount - pool.idleCount,
      idleConnections: pool.idleCount,
      waitingClients: pool.waitingCount,
      error: error.message,
    };
  }
}
