import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const JWT_ISSUER = process.env.JWT_ISSUER || 'meridian-auth-service';

interface JwtPayload {
  userId: string;
  email: string;
  roles: string[];
  clientId?: string;
  organizationId: string;
  permissions?: string[];
  // v2 tokens include these:
  sessionId?: string;
  mfaVerified?: boolean;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: string[];
  clientId?: string;
  organizationId: string;
  permissions: string[];
  sessionId?: string;
  mfaVerified?: boolean;
}

/**
 * JWT Authentication middleware.
 *
 * Validates the Bearer token in the Authorization header.
 * Sets req.user with the decoded payload for downstream use.
 *
 * Note: actual token issuance is handled by the auth-service.
 * We just validate here.
 */
export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Skip auth for health checks (shouldn't hit this since health is mounted before auth)
  if (req.path === '/health' || req.path === '/ready') {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header is required',
    });
  }

  // Support "Bearer <token>" format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header must use Bearer scheme',
    });
  }

  const token = parts[1];

  /*
  // Legacy token format support (pre-v2.0 clients)
  // These tokens used a different signing key and format
  // Disabled 2024-03-15 after migration deadline passed
  // Keeping code in case we need to re-enable for stragglers
  //
  // if (token.startsWith('mht_')) {
  //   try {
  //     const legacyPayload = validateLegacyToken(token);
  //     (req as any).user = {
  //       userId: legacyPayload.sub,
  //       email: legacyPayload.email,
  //       roles: [legacyPayload.role], // legacy tokens had single role
  //       clientId: legacyPayload.client_id,
  //       organizationId: legacyPayload.org_id || 'default',
  //       permissions: mapLegacyPermissions(legacyPayload.role),
  //     };
  //     (req as any).isLegacyAuth = true;
  //     return next();
  //   } catch (err) {
  //     return res.status(401).json({ error: 'Invalid legacy token' });
  //   }
  // }
  */

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      algorithms: ['HS256'], // TODO: switch to RS256 with key pair (PLAT-1200)
    }) as JwtPayload;

    // Attach user info to request
    const user: AuthenticatedUser = {
      userId: decoded.userId,
      email: decoded.email,
      roles: decoded.roles || [],
      clientId: decoded.clientId,
      organizationId: decoded.organizationId,
      permissions: decoded.permissions || derivePermissions(decoded.roles || []),
      sessionId: decoded.sessionId,
      mfaVerified: decoded.mfaVerified,
    };

    (req as any).user = user;

    // Add request ID for tracing
    (req as any).requestId = req.headers['x-request-id'] || generateRequestId();

    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Token has expired',
        code: 'TOKEN_EXPIRED',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
        code: 'INVALID_TOKEN',
      });
    }

    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication failed',
    });
  }
};

/**
 * Role-based access control middleware factory
 */
export const requireRoles = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as AuthenticatedUser;

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const hasRole = roles.some(role => user.roles.includes(role));
    if (!hasRole) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: roles,
      });
    }

    next();
  };
};

/**
 * Permission-based access control middleware factory
 */
export const requirePermissions = (...permissions: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as AuthenticatedUser;

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const hasPermission = permissions.every(perm => user.permissions.includes(perm));
    if (!hasPermission) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: permissions,
      });
    }

    next();
  };
};

// Derive permissions from roles when token doesn't include explicit permissions
// This is the old way - new tokens include permissions directly
function derivePermissions(roles: string[]): string[] {
  const permMap: Record<string, string[]> = {
    'admin': ['patient:read', 'patient:write', 'patient:delete', 'patient:merge', 'insurance:read', 'insurance:write', 'reports:read'],
    'provider': ['patient:read', 'patient:write', 'insurance:read'],
    'nurse': ['patient:read', 'patient:write', 'insurance:read'],
    'front-desk': ['patient:read', 'patient:write', 'insurance:read', 'insurance:write'],
    'billing': ['patient:read', 'insurance:read', 'insurance:write', 'reports:read'],
    'readonly': ['patient:read', 'insurance:read'],
  };

  const permissions = new Set<string>();
  for (const role of roles) {
    const rolePerms = permMap[role] || [];
    rolePerms.forEach(p => permissions.add(p));
  }

  return Array.from(permissions);
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Dead code - was for legacy token validation
// function validateLegacyToken(token: string) { ... }
// function mapLegacyPermissions(role: string) { ... }
