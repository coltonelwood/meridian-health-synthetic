/**
 * Log transports for different backends.
 *
 * PostgreSQL transport: Primary audit log storage. Uses batching to
 * avoid overwhelming the database with individual INSERTs. Batch is
 * flushed every 5 seconds or when it reaches 100 entries.
 *
 * CloudWatch transport: Secondary, used for real-time alerting via
 * CloudWatch Alarms. Less detailed than PostgreSQL.
 */

import Transport from 'winston-transport';
import { Pool, PoolConfig } from 'pg';

// --- PostgreSQL Transport ----------------------------------------------------

export interface PostgresTransportOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  table?: string;
  schema?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  ssl?: boolean;
}

export class PostgresAuditTransport extends Transport {
  private pool: Pool;
  private table: string;
  private schema: string;
  private batch: any[] = [];
  private batchSize: number;
  private flushInterval: NodeJS.Timeout;

  constructor(options: PostgresTransportOptions) {
    super();

    const poolConfig: PoolConfig = options.connectionString
      ? { connectionString: options.connectionString }
      : {
          host: options.host || 'localhost',
          port: options.port || 5432,
          database: options.database || 'meridian_audit',
          user: options.user || 'audit_writer',
          password: options.password,
        };

    if (options.ssl !== false) {
      poolConfig.ssl = { rejectUnauthorized: true };
    }

    // Separate pool for audit logs - don't share with application queries
    poolConfig.max = 5;
    poolConfig.idleTimeoutMillis = 30000;

    this.pool = new Pool(poolConfig);
    this.table = options.table || 'audit_log';
    this.schema = options.schema || 'audit';
    this.batchSize = options.batchSize || 100;

    // Flush batch periodically
    this.flushInterval = setInterval(
      () => this.flush(),
      options.flushIntervalMs || 5000
    );

    // Flush on process exit
    process.on('beforeExit', () => this.flush());
  }

  log(info: any, callback: () => void): void {
    this.batch.push({
      timestamp: info.timestamp || new Date().toISOString(),
      level: info.level,
      service: info.service,
      message: info.message,
      action: info.action,
      userId: info.userId,
      patientId: info.patientId,
      resource: info.resource,
      resourceId: info.resourceId,
      ipAddress: info.ipAddress,
      organizationId: info.organizationId,
      logType: info.logType || 'APPLICATION',
      metadata: JSON.stringify(info),
    });

    if (this.batch.length >= this.batchSize) {
      this.flush();
    }

    callback();
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const entries = [...this.batch];
    this.batch = [];

    try {
      // Batch INSERT for performance
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (const entry of entries) {
        const entryPlaceholders: string[] = [];
        for (const value of [
          entry.timestamp,
          entry.level,
          entry.service,
          entry.message,
          entry.action,
          entry.userId,
          entry.patientId,
          entry.resource,
          entry.resourceId,
          entry.ipAddress,
          entry.organizationId,
          entry.logType,
          entry.metadata,
        ]) {
          entryPlaceholders.push(`$${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
        placeholders.push(`(${entryPlaceholders.join(', ')})`);
      }

      const query = `
        INSERT INTO ${this.schema}.${this.table}
        (timestamp, level, service, message, action, user_id, patient_id,
         resource, resource_id, ip_address, organization_id, log_type, metadata)
        VALUES ${placeholders.join(', ')}
      `;

      await this.pool.query(query, values);
    } catch (error) {
      // If PostgreSQL is down, log to console as a fallback
      // We never want to lose audit entries
      console.error('[AUDIT LOG FAILURE] Failed to write to PostgreSQL:', error);
      console.error('[AUDIT LOG FAILURE] Entries that failed:', JSON.stringify(entries));
      // TODO: Write failed entries to a local file as a fallback
      // so they can be replayed when the database recovers
    }
  }

  async close(): Promise<void> {
    clearInterval(this.flushInterval);
    await this.flush();
    await this.pool.end();
  }
}

export function createPostgresTransport(options: PostgresTransportOptions): PostgresAuditTransport {
  return new PostgresAuditTransport(options);
}

// --- CloudWatch Transport ----------------------------------------------------

interface CloudWatchTransportOptions {
  logGroupName: string;
  logStreamName: string;
  region: string;
}

class CloudWatchAuditTransport extends Transport {
  private logGroupName: string;
  private logStreamName: string;
  private client: any; // CloudWatchLogsClient
  private batch: any[] = [];
  private flushInterval: NodeJS.Timeout;
  private sequenceToken?: string;

  constructor(options: CloudWatchTransportOptions) {
    super();

    this.logGroupName = options.logGroupName;
    this.logStreamName = options.logStreamName;

    // Lazy-load the AWS SDK to avoid import overhead in tests
    const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
    this.client = new CloudWatchLogsClient({ region: options.region });

    this.flushInterval = setInterval(() => this.flush(), 10000);
  }

  log(info: any, callback: () => void): void {
    this.batch.push({
      timestamp: Date.now(),
      message: JSON.stringify({
        level: info.level,
        service: info.service,
        message: info.message,
        action: info.action,
        logType: info.logType,
        userId: info.userId,
        patientId: info.patientId,
      }),
    });

    if (this.batch.length >= 50) {
      this.flush();
    }

    callback();
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const events = [...this.batch];
    this.batch = [];

    try {
      const { PutLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

      await this.client.send(new PutLogEventsCommand({
        logGroupName: this.logGroupName,
        logStreamName: this.logStreamName,
        logEvents: events.sort((a: any, b: any) => a.timestamp - b.timestamp),
        sequenceToken: this.sequenceToken,
      }));
    } catch (error: any) {
      // CloudWatch failure is non-critical - PostgreSQL is the primary audit log
      console.error('[CloudWatch Transport] Failed to send logs:', error.message);
    }
  }
}

export function createCloudWatchTransport(options: CloudWatchTransportOptions): CloudWatchAuditTransport {
  return new CloudWatchAuditTransport(options);
}
