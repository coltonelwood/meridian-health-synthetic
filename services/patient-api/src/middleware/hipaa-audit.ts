import { Request, Response, NextFunction } from 'express';
import winston from 'winston';

/**
 * HIPAA Audit Logging Middleware
 *
 * HIPAA Security Rule (45 CFR 164.312(b)) requires audit controls
 * to record and examine activity in information systems that contain
 * or use electronic protected health information (ePHI).
 *
 * This middleware logs all access to PHI-containing endpoints.
 *
 * Audit logs include:
 *  - Who accessed the data (user ID, role)
 *  - What was accessed (endpoint, resource ID)
 *  - When it was accessed (timestamp)
 *  - Where the access originated (IP address)
 *  - What action was performed (HTTP method / CRUD operation)
 *  - Whether the access was successful
 *
 * TODO: Performance concern (PLAT-4100)
 *   Currently this logs synchronously on every request which adds
 *   ~2-5ms latency. Should move to async logging with a message queue
 *   (e.g., send to Kafka/SQS and have a separate consumer write to
 *   the audit DB). The compliance team says synchronous is fine for
 *   now but it's going to be a problem at scale.
 *
 * TODO: move audit logs to dedicated audit database (PLAT-4101)
 *   Right now they go to the same Postgres instance which is not ideal
 *   for compliance - audit logs should be immutable and in a separate store.
 */

// Dedicated audit logger - separate from application logs
const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.json()
  ),
  defaultMeta: {
    logType: 'HIPAA_AUDIT',
    service: 'patient-api',
  },
  transports: [
    new winston.transports.Console(),
    // In production, this goes to a dedicated audit log stream
    // via CloudWatch -> S3 (immutable, 7-year retention)
    // new winston.transports.Stream({ stream: auditLogStream }),
  ],
});

// PHI-containing endpoints that require audit logging
// TODO: this should be configurable, not hardcoded
const PHI_ENDPOINTS = [
  '/api/v1/patients',
  '/api/v1/demographics',
  '/api/v1/insurance',
  '/api/patients', // legacy
];

// Sensitive operations that get extra scrutiny
const SENSITIVE_OPERATIONS: Record<string, string> = {
  'GET': 'VIEW',
  'POST': 'CREATE',
  'PUT': 'UPDATE',
  'PATCH': 'UPDATE',
  'DELETE': 'DELETE',
};

interface AuditLogEntry {
  eventId: string;
  timestamp: string;
  eventType: string;
  action: string;
  outcome: 'success' | 'failure';
  userId: string;
  userEmail: string;
  userRoles: string[];
  clientId?: string;
  organizationId: string;
  ipAddress: string;
  userAgent: string;
  httpMethod: string;
  endpoint: string;
  resourceType: string;
  resourceId?: string;
  queryParams?: Record<string, any>;
  responseStatus: number;
  responseTime: number;
  sessionId?: string;
  // We never log the actual PHI data - just metadata about the access
}

export const hipaaAuditMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Check if this endpoint contains PHI
  const isPHIEndpoint = PHI_ENDPOINTS.some(endpoint => req.path.startsWith(endpoint.replace('/api', '')));

  if (!isPHIEndpoint) {
    return next();
  }

  const startTime = Date.now();
  const user = (req as any).user;

  // Capture original res.json to intercept response
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  const logAuditEvent = (statusCode: number) => {
    const responseTime = Date.now() - startTime;

    // Extract resource ID from path if present
    const pathParts = req.path.split('/');
    let resourceId: string | undefined;
    let resourceType = 'unknown';

    // Simple path parsing to figure out what resource is being accessed
    if (req.path.includes('/patients')) {
      resourceType = 'Patient';
      // look for UUID in path
      const uuidMatch = req.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) {
        resourceId = uuidMatch[0];
      }
    } else if (req.path.includes('/demographics')) {
      resourceType = 'Demographics';
      const uuidMatch = req.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) {
        resourceId = uuidMatch[0];
      }
    } else if (req.path.includes('/insurance')) {
      resourceType = 'Insurance';
      const uuidMatch = req.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) {
        resourceId = uuidMatch[0];
      }
    }

    const auditEntry: AuditLogEntry = {
      eventId: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      eventType: 'PHI_ACCESS',
      action: SENSITIVE_OPERATIONS[req.method] || req.method,
      outcome: statusCode < 400 ? 'success' : 'failure',
      userId: user?.userId || 'anonymous',
      userEmail: user?.email || 'unknown',
      userRoles: user?.roles || [],
      clientId: user?.clientId,
      organizationId: user?.organizationId || 'unknown',
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || 'unknown',
      httpMethod: req.method,
      endpoint: req.path,
      resourceType,
      resourceId,
      queryParams: Object.keys(req.query).length > 0 ? sanitizeQueryParams(req.query) : undefined,
      responseStatus: statusCode,
      responseTime,
      sessionId: user?.sessionId,
    };

    // Log to audit trail
    auditLogger.info('PHI Access', auditEntry);

    // TODO: also write to audit_log table in database for querying
    // This is on the roadmap but for now we rely on CloudWatch logs
    // writeAuditToDatabase(auditEntry).catch(err => {
    //   auditLogger.error('Failed to write audit to database', { error: err.message, eventId: auditEntry.eventId });
    // });

    // Flag suspicious access patterns
    // TODO: implement proper anomaly detection (PLAT-6500)
    if (req.method === 'GET' && req.path.includes('/patients') && !resourceId) {
      // Bulk patient list access - might be data exfiltration
      // For now just log it, eventually we want alerts
      if (req.query.limit && parseInt(req.query.limit as string) > 50) {
        auditLogger.warn('Large patient list request detected', {
          userId: user?.userId,
          limit: req.query.limit,
          eventId: auditEntry.eventId,
        });
      }
    }
  };

  // Intercept response to capture status code
  res.json = function (body: any) {
    logAuditEvent(res.statusCode);
    return originalJson(body);
  };

  res.send = function (body: any) {
    logAuditEvent(res.statusCode);
    return originalSend(body);
  };

  next();
};

/**
 * Get client IP, handling proxies
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, first one is the client
    const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
    return ips[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Remove potentially sensitive values from query params before logging
 * We log that params were used but not their values for certain fields
 */
function sanitizeQueryParams(params: Record<string, any>): Record<string, any> {
  const sensitiveParams = ['ssn', 'dob', 'dateOfBirth', 'email', 'phone'];
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (sensitiveParams.includes(key)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
