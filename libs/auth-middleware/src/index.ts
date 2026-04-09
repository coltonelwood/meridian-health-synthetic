/**
 * @meridian/auth-middleware
 *
 * Express middleware for JWT verification and role-based access control (RBAC).
 * All Meridian API services use this middleware.
 *
 * Authentication flow:
 * 1. Client sends JWT in Authorization header (Bearer token)
 * 2. Middleware verifies the JWT signature and expiration
 * 3. Decoded token payload is attached to req.user
 * 4. RBAC middleware checks permissions based on role/permissions
 *
 * Token structure (see types.ts for full interface):
 * - sub: user ID
 * - email: user email
 * - roles: array of role names
 * - permissions: array of permission strings
 * - organizationId: tenant context
 * - facilityIds: which facilities the user can access
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthorizationError, HIPAAViolationError } from '@meridian/shared-utils';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { JWTPayload, Permission, Role, AuthConfig } from './types';
import { evaluateRBAC, hasPermission, hasRole, isRoleAtLeast } from './rbac';

const logger = new HIPAALogger({ service: 'auth-middleware' });

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

// --- Configuration -----------------------------------------------------------

const defaultConfig: AuthConfig = {
  jwtSecret: process.env.JWT_SECRET || '',
  jwtAlgorithm: 'HS256',
  tokenExpiry: '30m',
  // Paths that don't require authentication
  publicPaths: [
    '/health',
    '/health/ready',
    '/health/live',
    '/metrics',
  ],
  // Paths that require authentication but not RBAC
  authenticatedOnlyPaths: [
    '/api/v1/me',
    '/api/v1/me/preferences',
  ],
};

// --- Authentication Middleware -----------------------------------------------

/**
 * JWT authentication middleware.
 * Verifies the JWT token and attaches the decoded payload to req.user.
 */
export function authenticate(config?: Partial<AuthConfig>) {
  const mergedConfig = { ...defaultConfig, ...config };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip auth for public paths
    if (mergedConfig.publicPaths?.some(path => req.path.startsWith(path))) {
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required. Provide a valid Bearer token.',
        },
      });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.verify(token, mergedConfig.jwtSecret, {
        algorithms: [mergedConfig.jwtAlgorithm as jwt.Algorithm],
      }) as JWTPayload;

      // Check if user is active
      if (decoded.status === 'inactive' || decoded.status === 'locked') {
        logger.warn('Authentication attempt by inactive/locked user', {
          action: 'AUTH_INACTIVE_USER',
          userId: decoded.sub,
          status: decoded.status,
          ipAddress: req.ip,
        });

        res.status(401).json({
          error: {
            code: 'ACCOUNT_INACTIVE',
            message: 'Your account is inactive. Contact your administrator.',
          },
        });
        return;
      }

      req.user = decoded;
      next();
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        res.status(401).json({
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Token has expired. Please refresh your token.',
          },
        });
        return;
      }

      if (error.name === 'JsonWebTokenError') {
        logger.warn('Invalid JWT token presented', {
          action: 'AUTH_INVALID_TOKEN',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          error: error.message,
        });

        res.status(401).json({
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid token.',
          },
        });
        return;
      }

      next(error);
    }
  };
}

// --- Authorization Middleware ------------------------------------------------

/**
 * Role-based authorization middleware.
 * Checks if the authenticated user has the required role.
 *
 * Usage:
 * ```
 * app.get('/api/admin/users', authenticate(), requireRole('admin'), handler);
 * ```
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required.' },
      });
      return;
    }

    if (!hasRole(req.user, roles)) {
      logger.warn('Authorization denied - insufficient role', {
        action: 'AUTH_ROLE_DENIED',
        userId: req.user.sub,
        requiredRoles: roles,
        userRoles: req.user.roles,
        path: req.path,
        method: req.method,
      });

      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_ROLE',
          message: `Required role: ${roles.join(' or ')}`,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Permission-based authorization middleware.
 * More granular than role-based - checks specific permissions.
 *
 * Usage:
 * ```
 * app.put('/api/patients/:id', authenticate(), requirePermission('patient:update'), handler);
 * ```
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required.' },
      });
      return;
    }

    const hasAll = permissions.every(p => hasPermission(req.user!, p));

    if (!hasAll) {
      logger.warn('Authorization denied - insufficient permission', {
        action: 'AUTH_PERMISSION_DENIED',
        userId: req.user.sub,
        requiredPermissions: permissions,
        path: req.path,
        method: req.method,
      });

      res.status(403).json({
        error: {
          code: 'INSUFFICIENT_PERMISSION',
          message: `Required permission: ${permissions.join(', ')}`,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Facility-based access control.
 * Restricts access to data within the user's assigned facilities.
 * This is critical for multi-facility organizations where providers
 * should only see patients at their facilities.
 *
 * Usage:
 * ```
 * app.get('/api/patients', authenticate(), requireFacility(), handler);
 * ```
 */
export function requireFacility(facilityIdParam: string = 'facilityId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required.' },
      });
      return;
    }

    // System admins can access all facilities
    if (req.user.roles.includes('system_admin')) {
      return next();
    }

    const requestedFacility = req.params[facilityIdParam] ||
      req.query[facilityIdParam] as string ||
      req.body?.[facilityIdParam];

    if (requestedFacility && !req.user.facilityIds?.includes(requestedFacility)) {
      logger.warn('HIPAA: Cross-facility access attempt', {
        action: 'HIPAA_FACILITY_VIOLATION',
        userId: req.user.sub,
        requestedFacility,
        userFacilities: req.user.facilityIds,
        path: req.path,
        ipAddress: req.ip,
      });

      res.status(403).json({
        error: {
          code: 'FACILITY_ACCESS_DENIED',
          message: 'You do not have access to this facility.',
        },
      });
      return;
    }

    next();
  };
}

// Re-export types and RBAC utilities
export { JWTPayload, Permission, Role, AuthConfig } from './types';
export { evaluateRBAC, hasPermission, hasRole, isRoleAtLeast } from './rbac';
