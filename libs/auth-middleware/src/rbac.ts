/**
 * RBAC (Role-Based Access Control) evaluation logic.
 *
 * Role hierarchy (higher roles inherit all permissions from lower roles):
 *
 * system_admin
 *   └── org_admin
 *         ├── provider
 *         │     └── nurse
 *         ├── billing_manager
 *         │     └── billing_specialist
 *         ├── care_coordinator
 *         ├── medical_records
 *         └── front_desk
 *
 * patient (separate hierarchy - portal access only)
 */

import { JWTPayload, Permission, Role } from './types';

// Role hierarchy - each role includes all permissions from roles it contains
const ROLE_HIERARCHY: Record<Role, Role[]> = {
  system_admin: ['org_admin', 'provider', 'nurse', 'billing_manager', 'billing_specialist', 'care_coordinator', 'medical_records', 'front_desk'],
  org_admin: ['provider', 'nurse', 'billing_manager', 'billing_specialist', 'care_coordinator', 'medical_records', 'front_desk'],
  provider: ['nurse'],
  nurse: [],
  billing_manager: ['billing_specialist'],
  billing_specialist: [],
  front_desk: [],
  care_coordinator: [],
  medical_records: [],
  patient: [],
};

// Default permissions per role
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  system_admin: [
    'admin:users', 'admin:roles', 'admin:audit_log', 'admin:settings', 'admin:reports',
    'patient:read', 'patient:create', 'patient:update', 'patient:delete', 'patient:merge', 'patient:export',
    'clinical:read', 'clinical:write', 'clinical:sign', 'clinical:amend',
    'claim:read', 'claim:create', 'claim:update', 'claim:submit', 'claim:void', 'claim:appeal',
    'schedule:read', 'schedule:create', 'schedule:update', 'schedule:cancel',
    'referral:read', 'referral:create', 'referral:update',
    'document:read', 'document:upload', 'document:delete',
  ],
  org_admin: [
    'admin:users', 'admin:roles', 'admin:settings', 'admin:reports',
    'patient:read', 'patient:create', 'patient:update', 'patient:merge',
    'clinical:read',
    'claim:read', 'claim:create', 'claim:update', 'claim:submit', 'claim:appeal',
    'schedule:read', 'schedule:create', 'schedule:update', 'schedule:cancel',
    'referral:read', 'referral:create', 'referral:update',
    'document:read', 'document:upload',
  ],
  provider: [
    'patient:read', 'patient:create', 'patient:update',
    'clinical:read', 'clinical:write', 'clinical:sign', 'clinical:amend',
    'schedule:read', 'schedule:create', 'schedule:update', 'schedule:cancel',
    'referral:read', 'referral:create', 'referral:update',
    'document:read', 'document:upload',
  ],
  nurse: [
    'patient:read', 'patient:update',
    'clinical:read', 'clinical:write',
    'schedule:read', 'schedule:update',
    'referral:read',
    'document:read', 'document:upload',
  ],
  billing_manager: [
    'patient:read',
    'claim:read', 'claim:create', 'claim:update', 'claim:submit', 'claim:void', 'claim:appeal',
    'schedule:read',
    'admin:reports',
    'document:read',
  ],
  billing_specialist: [
    'patient:read',
    'claim:read', 'claim:create', 'claim:update', 'claim:submit', 'claim:appeal',
    'schedule:read',
    'document:read',
  ],
  front_desk: [
    'patient:read', 'patient:create', 'patient:update',
    'schedule:read', 'schedule:create', 'schedule:update', 'schedule:cancel',
    'document:read', 'document:upload',
  ],
  care_coordinator: [
    'patient:read', 'patient:update',
    'clinical:read',
    'schedule:read', 'schedule:create', 'schedule:update',
    'referral:read', 'referral:create', 'referral:update',
    'document:read', 'document:upload',
  ],
  medical_records: [
    'patient:read',
    'clinical:read',
    'document:read', 'document:upload', 'document:delete',
  ],
  patient: [
    'patient:read', // Own record only (enforced at service level)
    'schedule:read', // Own appointments only
    'document:read', // Own documents only
  ],
};

/**
 * Check if a user has at least one of the specified roles,
 * considering the role hierarchy.
 */
export function hasRole(user: JWTPayload, requiredRoles: Role[]): boolean {
  return requiredRoles.some(required => {
    // Direct match
    if (user.roles.includes(required)) return true;

    // Check if any of the user's roles include the required role via hierarchy
    return user.roles.some(userRole => {
      const inherited = ROLE_HIERARCHY[userRole] || [];
      return inherited.includes(required);
    });
  });
}

/**
 * Check if a user has a specific permission.
 * Permissions come from:
 * 1. The JWT token itself (explicit permissions)
 * 2. The user's roles (role-based permissions)
 */
export function hasPermission(user: JWTPayload, permission: Permission): boolean {
  // Check explicit permissions in the token
  if (user.permissions?.includes(permission)) return true;

  // Check role-based permissions
  for (const role of user.roles) {
    const rolePerms = ROLE_PERMISSIONS[role];
    if (rolePerms?.includes(permission)) return true;

    // Check inherited role permissions
    const inheritedRoles = ROLE_HIERARCHY[role] || [];
    for (const inherited of inheritedRoles) {
      const inheritedPerms = ROLE_PERMISSIONS[inherited];
      if (inheritedPerms?.includes(permission)) return true;
    }
  }

  return false;
}

/**
 * Check if a user's role is at or above a given level in the hierarchy.
 * Useful for "at least this level" checks.
 */
export function isRoleAtLeast(user: JWTPayload, minimumRole: Role): boolean {
  return user.roles.some(userRole => {
    if (userRole === minimumRole) return true;
    const inherited = ROLE_HIERARCHY[userRole] || [];
    return inherited.includes(minimumRole);
  });
}

/**
 * Evaluate a full RBAC policy.
 * Returns whether the user is allowed and why.
 */
export function evaluateRBAC(
  user: JWTPayload,
  requiredRoles?: Role[],
  requiredPermissions?: Permission[],
): { allowed: boolean; reason?: string } {
  if (requiredRoles && requiredRoles.length > 0) {
    if (!hasRole(user, requiredRoles)) {
      return {
        allowed: false,
        reason: `User lacks required role: ${requiredRoles.join(' or ')}`,
      };
    }
  }

  if (requiredPermissions && requiredPermissions.length > 0) {
    const missing = requiredPermissions.filter(p => !hasPermission(user, p));
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `User lacks required permissions: ${missing.join(', ')}`,
      };
    }
  }

  return { allowed: true };
}
