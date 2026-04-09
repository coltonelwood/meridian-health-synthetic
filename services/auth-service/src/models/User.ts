import { pool } from '../db';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

// TODO: move to shared types package (@meridian-health/types)
// Right now every service has its own copy of these interfaces
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: string;
  permissions: string[];  // override permissions beyond role defaults
  organizationId: string;
  mfaEnabled: boolean;
  mfaSecret?: string;
  lastLogin?: Date;
  failedAttempts: number;
  lockedUntil?: Date;
  passwordChangedAt?: Date;
  passwordHistory: string[];  // HIPAA: store last N password hashes to prevent reuse
  isActive: boolean;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
  // Added for SSO users - they don't have a local password
  ssoProvider?: string;
  ssoExternalId?: string;
  // Patient-specific fields (null for non-patient users)
  // TODO: these should probably be in a separate patient_profiles table
  dateOfBirth?: string;
  phoneNumber?: string;
  // Preferences
  notificationPreferences?: {
    email: boolean;
    sms: boolean;
    push: boolean;
  };
}

export interface CreateUserDTO {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: string;
  organizationId: string;
  createdBy?: string;
}

// HIPAA: number of previous passwords to check against
const PASSWORD_HISTORY_LENGTH = 12;
// Account lockout after N failed attempts
const MAX_FAILED_ATTEMPTS = 5;
// Lockout duration in minutes
const LOCKOUT_DURATION_MINUTES = 30;
// bcrypt salt rounds
const SALT_ROUNDS = 12; // bumped from 10 in 2024-09 after security audit

export class UserModel {
  /**
   * Find user by email (for login)
   * NOTE: this returns the full user object including passwordHash
   * - only use for auth flows, use findByIdSafe for everything else
   */
  async findByEmail(email: string): Promise<User | null> {
    const result = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true`,
      [email]
    );

    if (result.rows.length === 0) return null;

    return this.mapRowToUser(result.rows[0]);
  }

  /**
   * Find user by ID - excludes sensitive fields
   */
  async findByIdSafe(id: string): Promise<Omit<User, 'passwordHash' | 'mfaSecret' | 'passwordHistory'> | null> {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, permissions, organization_id,
              mfa_enabled, last_login, is_active, email_verified,
              created_at, updated_at, notification_preferences,
              sso_provider, date_of_birth, phone_number
       FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    return this.mapRowToUser(result.rows[0]) as any;
  }

  /**
   * Find user by ID - full object (for auth operations)
   */
  async findById(id: string): Promise<User | null> {
    const result = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    return this.mapRowToUser(result.rows[0]);
  }

  /**
   * Create a new user
   */
  async create(dto: CreateUserDTO): Promise<User> {
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name, role,
                          organization_id, password_history, created_by, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
      [
        id, dto.email, passwordHash, dto.firstName, dto.lastName,
        dto.role, dto.organizationId, JSON.stringify([passwordHash]),
        dto.createdBy || null,
      ]
    );

    return this.mapRowToUser(result.rows[0]);
  }

  /**
   * Verify password and handle account lockout
   */
  async verifyPassword(user: User, password: string): Promise<{ success: boolean; locked?: boolean; remainingAttempts?: number }> {
    // Check if account is locked
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return { success: false, locked: true };
    }

    // If lock has expired, reset the counter
    if (user.lockedUntil && new Date(user.lockedUntil) <= new Date()) {
      await pool.query(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id]
      );
      user.failedAttempts = 0;
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      const newFailedAttempts = user.failedAttempts + 1;

      if (newFailedAttempts >= MAX_FAILED_ATTEMPTS) {
        // Lock the account
        const lockUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
        await pool.query(
          `UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3`,
          [newFailedAttempts, lockUntil, user.id]
        );
        return { success: false, locked: true, remainingAttempts: 0 };
      }

      await pool.query(
        `UPDATE users SET failed_attempts = $1 WHERE id = $2`,
        [newFailedAttempts, user.id]
      );

      return {
        success: false,
        remainingAttempts: MAX_FAILED_ATTEMPTS - newFailedAttempts,
      };
    }

    // Reset failed attempts on successful login
    await pool.query(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1`,
      [user.id]
    );

    return { success: true };
  }

  /**
   * Update password with history check
   */
  async updatePassword(userId: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const user = await this.findById(userId);
    if (!user) return { success: false, error: 'User not found' };

    // HIPAA: Check password history
    const history = user.passwordHistory || [];
    for (const oldHash of history) {
      const isReused = await bcrypt.compare(newPassword, oldHash);
      if (isReused) {
        return {
          success: false,
          error: `Cannot reuse any of your last ${PASSWORD_HISTORY_LENGTH} passwords`,
        };
      }
    }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Keep only last N passwords in history
    const updatedHistory = [newHash, ...history].slice(0, PASSWORD_HISTORY_LENGTH);

    await pool.query(
      `UPDATE users SET
        password_hash = $1,
        password_history = $2,
        password_changed_at = NOW(),
        failed_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
       WHERE id = $3`,
      [newHash, JSON.stringify(updatedHistory), userId]
    );

    return { success: true };
  }

  /**
   * Record login for audit trail
   */
  async recordLogin(userId: string, ip: string, userAgent: string): Promise<void> {
    // TODO: should this be in a separate audit_log table?
    // Right now we only track last_login on the user record
    await pool.query(
      `UPDATE users SET last_login = NOW() WHERE id = $1`,
      [userId]
    );

    // Also insert into login_history for HIPAA audit
    await pool.query(
      `INSERT INTO login_history (user_id, ip_address, user_agent, logged_in_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, ip, userAgent]
    ).catch(err => {
      // Don't fail login if audit logging fails
      // TODO: this should alert somewhere - if audit logging is broken
      // we have a HIPAA compliance issue
      console.error('Failed to record login history:', err.message);
    });
  }

  /**
   * Map DB row to User object
   * (column names are snake_case in DB, camelCase in app)
   */
  private mapRowToUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      permissions: row.permissions || [],
      organizationId: row.organization_id,
      mfaEnabled: row.mfa_enabled || false,
      mfaSecret: row.mfa_secret,
      lastLogin: row.last_login,
      failedAttempts: row.failed_attempts || 0,
      lockedUntil: row.locked_until,
      passwordChangedAt: row.password_changed_at,
      passwordHistory: row.password_history ? JSON.parse(row.password_history) : [],
      isActive: row.is_active,
      emailVerified: row.email_verified || false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      ssoProvider: row.sso_provider,
      ssoExternalId: row.sso_external_id,
      dateOfBirth: row.date_of_birth,
      phoneNumber: row.phone_number,
      notificationPreferences: row.notification_preferences,
    };
  }
}
