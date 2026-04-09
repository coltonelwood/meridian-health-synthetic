import jwt from 'jsonwebtoken';
import { hasRole, hasPermission, isRoleAtLeast, evaluateRBAC } from '../src/rbac';
import { JWTPayload, Role, Permission } from '../src/types';

const JWT_SECRET = 'test-secret-key-for-testing-only';

function createMockUser(overrides: Partial<JWTPayload> = {}): JWTPayload {
  return {
    sub: 'user-123',
    email: 'test@meridianhealth.io',
    name: 'Test User',
    roles: ['provider'],
    permissions: [],
    organizationId: 'org-1',
    facilityIds: ['facility-1', 'facility-2'],
    status: 'active',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('RBAC - hasRole', () => {
  it('should return true for direct role match', () => {
    const user = createMockUser({ roles: ['provider'] });
    expect(hasRole(user, ['provider'])).toBe(true);
  });

  it('should return true for any of the required roles', () => {
    const user = createMockUser({ roles: ['nurse'] });
    expect(hasRole(user, ['provider', 'nurse'])).toBe(true);
  });

  it('should return false when role does not match', () => {
    const user = createMockUser({ roles: ['nurse'] });
    expect(hasRole(user, ['provider'])).toBe(false);
  });

  it('should respect role hierarchy - system_admin has all roles', () => {
    const user = createMockUser({ roles: ['system_admin'] });
    expect(hasRole(user, ['provider'])).toBe(true);
    expect(hasRole(user, ['billing_manager'])).toBe(true);
    expect(hasRole(user, ['front_desk'])).toBe(true);
    expect(hasRole(user, ['nurse'])).toBe(true);
  });

  it('should respect role hierarchy - org_admin includes provider', () => {
    const user = createMockUser({ roles: ['org_admin'] });
    expect(hasRole(user, ['provider'])).toBe(true);
    expect(hasRole(user, ['billing_specialist'])).toBe(true);
  });

  it('should not allow upward hierarchy access', () => {
    const user = createMockUser({ roles: ['nurse'] });
    expect(hasRole(user, ['provider'])).toBe(false);
    expect(hasRole(user, ['system_admin'])).toBe(false);
  });

  it('should handle patient role separately', () => {
    const user = createMockUser({ roles: ['patient'] });
    expect(hasRole(user, ['patient'])).toBe(true);
    expect(hasRole(user, ['provider'])).toBe(false);
    expect(hasRole(user, ['front_desk'])).toBe(false);
  });
});

describe('RBAC - hasPermission', () => {
  it('should check explicit permissions in token', () => {
    const user = createMockUser({
      roles: [],
      permissions: ['patient:read', 'patient:update'],
    });
    expect(hasPermission(user, 'patient:read')).toBe(true);
    expect(hasPermission(user, 'patient:delete')).toBe(false);
  });

  it('should check role-based permissions', () => {
    const user = createMockUser({ roles: ['provider'] });
    expect(hasPermission(user, 'patient:read')).toBe(true);
    expect(hasPermission(user, 'clinical:write')).toBe(true);
    expect(hasPermission(user, 'clinical:sign')).toBe(true);
    expect(hasPermission(user, 'claim:submit')).toBe(false); // Providers don't submit claims
  });

  it('should check inherited role permissions', () => {
    const user = createMockUser({ roles: ['billing_manager'] });
    // billing_manager inherits billing_specialist permissions
    expect(hasPermission(user, 'claim:read')).toBe(true);
    expect(hasPermission(user, 'claim:void')).toBe(true);
    // But shouldn't have clinical permissions
    expect(hasPermission(user, 'clinical:write')).toBe(false);
  });

  it('should handle nurse permissions correctly', () => {
    const user = createMockUser({ roles: ['nurse'] });
    expect(hasPermission(user, 'patient:read')).toBe(true);
    expect(hasPermission(user, 'clinical:read')).toBe(true);
    expect(hasPermission(user, 'clinical:write')).toBe(true);
    // Nurses can't sign notes
    expect(hasPermission(user, 'clinical:sign')).toBe(false);
  });

  it('should handle patient permissions correctly', () => {
    const user = createMockUser({ roles: ['patient'] });
    expect(hasPermission(user, 'patient:read')).toBe(true);
    expect(hasPermission(user, 'schedule:read')).toBe(true);
    // Patients can't create other patients or access claims
    expect(hasPermission(user, 'patient:create')).toBe(false);
    expect(hasPermission(user, 'claim:read')).toBe(false);
  });
});

describe('RBAC - isRoleAtLeast', () => {
  it('should return true for exact role', () => {
    const user = createMockUser({ roles: ['provider'] });
    expect(isRoleAtLeast(user, 'provider')).toBe(true);
  });

  it('should return true for higher roles', () => {
    const user = createMockUser({ roles: ['org_admin'] });
    expect(isRoleAtLeast(user, 'provider')).toBe(true);
    expect(isRoleAtLeast(user, 'nurse')).toBe(true);
  });

  it('should return false for lower roles checking higher', () => {
    const user = createMockUser({ roles: ['nurse'] });
    expect(isRoleAtLeast(user, 'provider')).toBe(false);
    expect(isRoleAtLeast(user, 'org_admin')).toBe(false);
  });
});

describe('RBAC - evaluateRBAC', () => {
  it('should allow when all requirements are met', () => {
    const user = createMockUser({ roles: ['provider'] });
    const result = evaluateRBAC(user, ['provider'], ['patient:read']);
    expect(result.allowed).toBe(true);
  });

  it('should deny when role is missing', () => {
    const user = createMockUser({ roles: ['nurse'] });
    const result = evaluateRBAC(user, ['provider']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('role');
  });

  it('should deny when permission is missing', () => {
    const user = createMockUser({ roles: ['nurse'] });
    const result = evaluateRBAC(user, undefined, ['clinical:sign']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('permissions');
  });

  it('should allow when no requirements specified', () => {
    const user = createMockUser({ roles: ['nurse'] });
    const result = evaluateRBAC(user);
    expect(result.allowed).toBe(true);
  });
});

describe('JWT token generation and verification', () => {
  it('should generate a valid JWT token', () => {
    const payload = createMockUser();
    const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });

    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    expect(decoded.sub).toBe('user-123');
    expect(decoded.roles).toContain('provider');
  });

  it('should reject expired tokens', () => {
    const payload = createMockUser({
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    const token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });

    expect(() => jwt.verify(token, JWT_SECRET)).toThrow('jwt expired');
  });

  it('should reject tokens with wrong secret', () => {
    const payload = createMockUser();
    const token = jwt.sign(payload, 'wrong-secret', { algorithm: 'HS256' });

    expect(() => jwt.verify(token, JWT_SECRET)).toThrow('invalid signature');
  });
});
