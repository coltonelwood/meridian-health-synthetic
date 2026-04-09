/**
 * @meridian/hipaa-logger
 *
 * HIPAA-compliant audit logger that tracks all PHI access events.
 * Required by HIPAA Security Rule (45 CFR 164.312(b)):
 * "Implement hardware, software, and/or procedural mechanisms that
 * record and examine activity in information systems that contain or
 * use electronic protected health information."
 *
 * This logger supports multiple backends:
 * - PostgreSQL (primary - for queryable audit trail)
 * - CloudWatch Logs (secondary - for real-time alerting)
 * - Console (development only)
 *
 * PHI Access events that MUST be logged:
 * - Patient record access (read)
 * - Patient record creation
 * - Patient record modification
 * - Patient record deletion (soft delete)
 * - PHI export/download
 * - PHI transmission to external systems
 * - Failed access attempts
 *
 * Retention: 6 years minimum per HIPAA (we retain for 7 years)
 */

import winston from 'winston';
import { redactSensitiveFields, formatLogEntry } from './formatters';
import { createPostgresTransport, createCloudWatchTransport, PostgresTransportOptions } from './transports';

// --- Types -------------------------------------------------------------------

export interface HIPAALoggerConfig {
  service: string;
  environment?: string;
  logLevel?: string;
  // PostgreSQL audit log storage
  postgres?: PostgresTransportOptions;
  // CloudWatch for real-time monitoring
  cloudwatch?: {
    logGroupName: string;
    region?: string;
  };
  // Additional fields to redact beyond the defaults
  additionalRedactedFields?: string[];
  // Whether to log to console (useful for development)
  console?: boolean;
}

export interface AuditLogEntry {
  action: string;
  userId?: string;
  patientId?: string;
  resource?: string;
  resourceId?: string;
  // IP address of the requester (for access tracking)
  ipAddress?: string;
  // User agent (helps identify access source)
  userAgent?: string;
  // Organization context (multi-tenant support)
  organizationId?: string;
  // Additional metadata (must not contain PHI!)
  [key: string]: any;
}

// PHI action types for typed audit logging
export type PHIAction =
  | 'PHI_ACCESS'    // Read access to PHI
  | 'PHI_CREATE'    // New PHI record created
  | 'PHI_UPDATE'    // PHI record modified
  | 'PHI_DELETE'    // PHI record deleted (soft)
  | 'PHI_EXPORT'    // PHI exported/downloaded
  | 'PHI_TRANSMIT'  // PHI sent to external system
  | 'PHI_DENIED';   // Access to PHI denied

// --- Logger Class ------------------------------------------------------------

export class HIPAALogger {
  private logger: winston.Logger;
  private service: string;
  private redactedFields: string[];

  constructor(config: HIPAALoggerConfig) {
    this.service = config.service;

    // Fields that should NEVER appear in logs
    this.redactedFields = [
      'ssn',
      'social_security_number',
      'dateOfBirth',
      'date_of_birth',
      'dob',
      'address',
      'streetAddress',
      'street_address',
      'phoneNumber',
      'phone_number',
      'email',
      'emailAddress',
      'insurance_member_id',
      'memberId',
      'groupNumber',
      'group_number',
      'creditCard',
      'credit_card',
      'bankAccount',
      'bank_account',
      'password',
      'token',
      'apiKey',
      'api_key',
      ...(config.additionalRedactedFields || []),
    ];

    const transports: winston.transport[] = [];

    // Console transport (always in dev, never in prod unless explicitly enabled)
    if (config.console || config.environment === 'development' || config.environment === 'test') {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const redacted = redactSensitiveFields(meta, this.redactedFields);
              return `${timestamp} [${level}] [${this.service}] ${message} ${
                Object.keys(redacted).length > 0 ? JSON.stringify(redacted) : ''
              }`;
            })
          ),
        })
      );
    }

    // PostgreSQL transport for audit trail
    if (config.postgres) {
      transports.push(createPostgresTransport(config.postgres));
    }

    // CloudWatch transport for real-time monitoring
    if (config.cloudwatch) {
      transports.push(
        createCloudWatchTransport({
          logGroupName: config.cloudwatch.logGroupName,
          logStreamName: `${config.service}-${new Date().toISOString().split('T')[0]}`,
          region: config.cloudwatch.region || 'us-east-1',
        })
      );
    }

    // Always have at least console in production
    if (transports.length === 0) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        })
      );
    }

    this.logger = winston.createLogger({
      level: config.logLevel || 'info',
      defaultMeta: {
        service: this.service,
        environment: config.environment || process.env.NODE_ENV,
      },
      transports,
    });
  }

  /**
   * Log an audit event. This is the primary method for HIPAA audit logging.
   *
   * IMPORTANT: Never include PHI in the log message or metadata.
   * Use patientId and resourceId to reference PHI records - the audit
   * system can join these with the actual data if needed for investigation.
   */
  audit(message: string, entry: AuditLogEntry): void {
    const sanitized = redactSensitiveFields(entry, this.redactedFields);

    this.logger.info(message, {
      ...sanitized,
      logType: 'AUDIT',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Log a PHI access event with strongly-typed action.
   */
  phiAccess(entry: {
    action: PHIAction;
    userId: string;
    patientId: string;
    resource: string;
    resourceId?: string;
    ipAddress?: string;
    purpose?: string;
  }): void {
    this.audit(`PHI ${entry.action.toLowerCase().replace('phi_', '')}`, {
      ...entry,
      logType: 'PHI_AUDIT',
    });
  }

  // Standard log levels with automatic redaction

  info(message: string, meta?: Record<string, any>): void {
    const sanitized = meta ? redactSensitiveFields(meta, this.redactedFields) : {};
    this.logger.info(message, sanitized);
  }

  warn(message: string, meta?: Record<string, any>): void {
    const sanitized = meta ? redactSensitiveFields(meta, this.redactedFields) : {};
    this.logger.warn(message, sanitized);
  }

  error(message: string, meta?: Record<string, any>): void {
    const sanitized = meta ? redactSensitiveFields(meta, this.redactedFields) : {};
    this.logger.error(message, sanitized);
  }

  debug(message: string, meta?: Record<string, any>): void {
    const sanitized = meta ? redactSensitiveFields(meta, this.redactedFields) : {};
    this.logger.debug(message, sanitized);
  }

  /**
   * Create a child logger with additional context.
   * Useful for adding request-scoped metadata (requestId, userId, etc.)
   */
  child(meta: Record<string, any>): HIPAALogger {
    // This is a simplified version - in practice we'd create a proper
    // child instance that inherits the transports
    const childLogger = Object.create(this);
    childLogger.logger = this.logger.child(
      redactSensitiveFields(meta, this.redactedFields)
    );
    return childLogger;
  }
}
