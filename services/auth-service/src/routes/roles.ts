import { Router, Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { authenticateJWT, requireRole } from '../middleware/passport';
import { logger } from '../utils/logger';
import { pool } from '../db';

const router = Router();

// Predefined roles for the healthcare platform
// TODO: move these to database and make them configurable per organization
// Right now we're hardcoding roles which means every tenant gets the same set
export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'super_admin',
  ORG_ADMIN: 'org_admin',
  PROVIDER: 'provider',
  NURSE: 'nurse',
  FRONT_DESK: 'front_desk',
  BILLING_ADMIN: 'billing_admin',
  BILLING_STAFF: 'billing_staff',
  PATIENT: 'patient',
  // Added for the Lakewood Health partnership - they need a custom role
  // TODO: implement proper custom roles instead of hardcoding partner-specific ones
  CARE_COORDINATOR: 'care_coordinator',
  EXTERNAL_REVIEWER: 'external_reviewer',
} as const;

// Permission matrix - maps roles to permissions
// TODO: this should be in the DB, not hardcoded
// Also this doesn't support org-level permission overrides yet (AUTH-734)
const ROLE_PERMISSIONS: Record<string, string[]> = {
  [SYSTEM_ROLES.SUPER_ADMIN]: ['*'], // god mode - probably should be more granular
  [SYSTEM_ROLES.ORG_ADMIN]: [
    'users:read', 'users:write', 'users:delete',
    'roles:read', 'roles:assign',
    'org:read', 'org:write',
    'patients:read',
    'appointments:read', 'appointments:write',
    'billing:read',
    'reports:read', 'reports:write',
    'audit:read',
  ],
  [SYSTEM_ROLES.PROVIDER]: [
    'patients:read', 'patients:write',
    'appointments:read', 'appointments:write',
    'prescriptions:read', 'prescriptions:write',
    'notes:read', 'notes:write',
    'labs:read', 'labs:order',
    'billing:read', // can view but not modify
  ],
  [SYSTEM_ROLES.NURSE]: [
    'patients:read', 'patients:write',
    'appointments:read',
    'vitals:read', 'vitals:write',
    'notes:read', 'notes:write',
    'labs:read',
  ],
  [SYSTEM_ROLES.FRONT_DESK]: [
    'patients:read',
    'patients:create', // can create new patients but not edit existing PHI
    'appointments:read', 'appointments:write',
    'insurance:read', 'insurance:verify',
  ],
  [SYSTEM_ROLES.BILLING_ADMIN]: [
    'billing:read', 'billing:write', 'billing:delete',
    'claims:read', 'claims:write', 'claims:submit',
    'payments:read', 'payments:write',
    'patients:read',
    'reports:read',
  ],
  [SYSTEM_ROLES.BILLING_STAFF]: [
    'billing:read', 'billing:write',
    'claims:read', 'claims:write',
    'payments:read',
    'patients:read',
  ],
  [SYSTEM_ROLES.PATIENT]: [
    'own:read', 'own:write', // can only access their own data
    'appointments:read', 'appointments:book',
    'messages:read', 'messages:write',
    'billing:own:read',
  ],
  [SYSTEM_ROLES.CARE_COORDINATOR]: [
    'patients:read',
    'appointments:read', 'appointments:write',
    'referrals:read', 'referrals:write',
    'notes:read',
  ],
  [SYSTEM_ROLES.EXTERNAL_REVIEWER]: [
    'patients:read', // TODO: this is too broad - should be scoped to assigned cases only
    'notes:read',
    'labs:read',
  ],
};

/**
 * GET /
 * List all available roles
 */
router.get('/', authenticateJWT, requireRole([SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.ORG_ADMIN]), async (req: Request, res: Response) => {
  try {
    // TODO: when roles are in DB, query them here
    const roles = Object.entries(SYSTEM_ROLES).map(([key, value]) => ({
      id: value,
      name: key.replace(/_/g, ' ').toLowerCase(),
      permissions: ROLE_PERMISSIONS[value] || [],
    }));

    return res.json({ roles });
  } catch (error: any) {
    logger.error('Error listing roles', { error: error.message });
    return res.status(500).json({ error: 'Failed to list roles' });
  }
});

/**
 * GET /:roleId/permissions
 * Get permissions for a specific role
 */
router.get('/:roleId/permissions', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    const permissions = ROLE_PERMISSIONS[roleId];

    if (!permissions) {
      return res.status(404).json({ error: 'Role not found' });
    }

    return res.json({ roleId, permissions });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to get permissions' });
  }
});

/**
 * POST /assign
 * Assign a role to a user
 */
router.post('/assign', authenticateJWT, requireRole([SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.ORG_ADMIN]), [
  body('userId').isUUID(),
  body('roleId').isString().notEmpty(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId, roleId } = req.body;
    const assignedBy = (req as any).user?.id;

    // Validate role exists
    if (!Object.values(SYSTEM_ROLES).includes(roleId)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Don't allow non-super-admins to assign super_admin role
    // (defense in depth - the requireRole check above should catch this too)
    if (roleId === SYSTEM_ROLES.SUPER_ADMIN && (req as any).user?.role !== SYSTEM_ROLES.SUPER_ADMIN) {
      logger.warn('Unauthorized super_admin role assignment attempt', {
        attemptedBy: assignedBy,
        targetUser: userId,
      });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // TODO: implement org-scoped role assignment
    // Right now any org_admin can assign roles to any user in any org
    // which is a security issue for multi-tenant setups

    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3 RETURNING id, role`,
      [roleId, assignedBy, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // HIPAA audit log
    logger.info('Role assigned', {
      userId,
      roleId,
      assignedBy,
      timestamp: new Date().toISOString(),
    });

    return res.json({ success: true, user: result.rows[0] });
  } catch (error: any) {
    logger.error('Role assignment error', { error: error.message });
    return res.status(500).json({ error: 'Failed to assign role' });
  }
});

/**
 * POST /revoke
 * Revoke a role from a user (sets them to patient role)
 * TODO: implement proper role revocation - right now we just downgrade to patient
 */
router.post('/revoke', authenticateJWT, requireRole([SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.ORG_ADMIN]), [
  body('userId').isUUID(),
], async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    const revokedBy = (req as any).user?.id;

    // Can't revoke your own role
    if (userId === revokedBy) {
      return res.status(400).json({ error: 'Cannot revoke your own role' });
    }

    const result = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3 RETURNING id, role`,
      [SYSTEM_ROLES.PATIENT, revokedBy, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info('Role revoked', { userId, revokedBy, newRole: SYSTEM_ROLES.PATIENT });

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Role revocation error', { error: error.message });
    return res.status(500).json({ error: 'Failed to revoke role' });
  }
});

/**
 * Helper: check if a user has a specific permission
 */
export function hasPermission(userRole: string, permission: string): boolean {
  const permissions = ROLE_PERMISSIONS[userRole];
  if (!permissions) return false;

  // Super admin wildcard
  if (permissions.includes('*')) return true;

  // Check exact match
  if (permissions.includes(permission)) return true;

  // Check wildcard patterns (e.g., 'patients:*' matches 'patients:read')
  // TODO: this doesn't actually work yet - we don't have wildcard permissions in the matrix
  const [resource] = permission.split(':');
  if (permissions.includes(`${resource}:*`)) return true;

  return false;
}

export default router;
