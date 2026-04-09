/**
 * Custom error classes for Meridian Health services.
 *
 * All services should use these error classes instead of generic Error
 * objects. This enables:
 * - Consistent error response format across all APIs
 * - Proper HTTP status code mapping
 * - Structured logging with error codes
 * - Error categorization for monitoring/alerting
 */

/**
 * Base application error. All custom errors extend this.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    code: string = 'INTERNAL_ERROR',
    statusCode: number = 500,
    isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    // Maintain proper stack trace (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, any> {
    return {
      error: {
        code: this.code,
        message: this.message,
        // Don't include stack trace in JSON responses
      },
    };
  }
}

/**
 * Validation error (400 Bad Request).
 * Includes an array of specific field-level errors.
 */
export class ValidationError extends AppError {
  public readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message, 'VALIDATION_ERROR', 400);
    this.details = details;
  }

  toJSON(): Record<string, any> {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

/**
 * Resource not found (404).
 */
export class NotFoundError extends AppError {
  public readonly resourceType: string;
  public readonly resourceId: string;

  constructor(resourceType: string, resourceId: string) {
    super(`${resourceType} not found: ${resourceId}`, 'NOT_FOUND', 404);
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

/**
 * Authorization error (403 Forbidden).
 * Used when a user is authenticated but doesn't have permission.
 */
export class AuthorizationError extends AppError {
  public readonly requiredPermission?: string;
  public readonly userId?: string;

  constructor(
    message: string = 'Insufficient permissions',
    requiredPermission?: string,
    userId?: string
  ) {
    super(message, 'AUTHORIZATION_ERROR', 403);
    this.requiredPermission = requiredPermission;
    this.userId = userId;
  }
}

/**
 * HIPAA Violation Error.
 *
 * This is a CRITICAL error that indicates a potential HIPAA violation.
 * It is logged separately and triggers security team notification.
 *
 * Examples:
 * - Attempting to access a patient record without a valid treatment relationship
 * - Bulk export of PHI without proper authorization
 * - Accessing records outside of assigned facility/department
 */
export class HIPAAViolationError extends AppError {
  public readonly violationType: string;
  public readonly userId: string;
  public readonly patientId?: string;
  public readonly attemptedAction: string;

  constructor(
    violationType: string,
    userId: string,
    attemptedAction: string,
    patientId?: string
  ) {
    super(
      `HIPAA violation: ${violationType}`,
      'HIPAA_VIOLATION',
      403,
      true // This is always operational - it means someone did something wrong
    );
    this.violationType = violationType;
    this.userId = userId;
    this.patientId = patientId;
    this.attemptedAction = attemptedAction;
  }
}

/**
 * Conflict error (409).
 * Used for duplicate records, concurrent modifications, etc.
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

/**
 * External service error (502 Bad Gateway).
 * Used when a downstream service (clearinghouse, payer API, etc.) fails.
 */
export class ExternalServiceError extends AppError {
  public readonly serviceName: string;
  public readonly originalError?: string;

  constructor(serviceName: string, message: string, originalError?: string) {
    super(
      `External service error (${serviceName}): ${message}`,
      'EXTERNAL_SERVICE_ERROR',
      502
    );
    this.serviceName = serviceName;
    this.originalError = originalError;
  }
}

/**
 * Type guard to check if an error is an AppError.
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
