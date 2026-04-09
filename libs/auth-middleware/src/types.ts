/**
 * Auth type definitions.
 */

export interface JWTPayload {
  sub: string;           // User ID
  email: string;
  name: string;
  roles: Role[];
  permissions: Permission[];
  organizationId: string;
  facilityIds?: string[];
  status: 'active' | 'inactive' | 'locked';
  iat: number;           // Issued at
  exp: number;           // Expiration
}

// Roles are hierarchical - higher roles inherit permissions from lower roles
export type Role =
  | 'system_admin'       // Full system access (Meridian staff only)
  | 'org_admin'          // Organization administrator
  | 'provider'           // Licensed healthcare provider (MD, DO, NP, PA)
  | 'nurse'              // Registered nurse
  | 'billing_manager'    // Billing/revenue cycle manager
  | 'billing_specialist' // Billing/revenue cycle staff
  | 'front_desk'         // Front desk/reception
  | 'care_coordinator'   // Care coordination staff
  | 'medical_records'    // Medical records staff
  | 'patient';           // Patient (portal access only)

// Fine-grained permissions for RBAC
export type Permission =
  // Patient permissions
  | 'patient:read'
  | 'patient:create'
  | 'patient:update'
  | 'patient:delete'     // Soft delete only
  | 'patient:merge'      // Merge duplicate records
  | 'patient:export'     // Bulk export (requires additional audit)
  // Clinical permissions
  | 'clinical:read'
  | 'clinical:write'
  | 'clinical:sign'      // Sign off on clinical notes
  | 'clinical:amend'     // Amend signed notes
  // Claims permissions
  | 'claim:read'
  | 'claim:create'
  | 'claim:update'
  | 'claim:submit'
  | 'claim:void'
  | 'claim:appeal'
  // Scheduling permissions
  | 'schedule:read'
  | 'schedule:create'
  | 'schedule:update'
  | 'schedule:cancel'
  // Referral permissions
  | 'referral:read'
  | 'referral:create'
  | 'referral:update'
  // Admin permissions
  | 'admin:users'
  | 'admin:roles'
  | 'admin:audit_log'
  | 'admin:settings'
  | 'admin:reports'
  // Document permissions
  | 'document:read'
  | 'document:upload'
  | 'document:delete';

export interface AuthConfig {
  jwtSecret: string;
  jwtAlgorithm: string;
  tokenExpiry: string;
  publicPaths?: string[];
  authenticatedOnlyPaths?: string[];
}
