import { pool } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface Session {
  id: string;
  userId: string;
  token: string;
  refreshToken: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  isRevoked: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  // Track which device/client created this session
  deviceId?: string;
  clientType?: 'web' | 'mobile_ios' | 'mobile_android' | 'api';
}

// Session expiry times
const ACCESS_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// TODO: make these configurable per org
// Some orgs want shorter session times for security
// Memorial Health requested 8-hour sessions (ticket AUTH-445)

// Max concurrent sessions per user
// NOTE: we're not actually enforcing this yet
const MAX_SESSIONS_PER_USER = 5;

export class SessionModel {
  /**
   * Create a new session
   */
  async create(userId: string, token: string, refreshToken: string, meta?: {
    ipAddress?: string;
    userAgent?: string;
    deviceId?: string;
    clientType?: Session['clientType'];
  }): Promise<Session> {
    const id = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL);

    // TODO: enforce MAX_SESSIONS_PER_USER
    // When we hit the limit, should we revoke the oldest session or reject the new login?
    // Product hasn't decided yet. For now, just let it grow unbounded.
    // WARNING: we've seen users with 40+ active sessions which is probably not great

    const result = await pool.query(
      `INSERT INTO sessions (id, user_id, token, refresh_token, expires_at,
                             refresh_expires_at, ip_address, user_agent,
                             device_id, client_type, created_at, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       RETURNING *`,
      [
        id, userId, token, refreshToken, expiresAt, refreshExpiresAt,
        meta?.ipAddress, meta?.userAgent, meta?.deviceId, meta?.clientType,
        now,
      ]
    );

    return this.mapRow(result.rows[0]);
  }

  /**
   * Find session by access token
   */
  async findByToken(token: string): Promise<Session | null> {
    const result = await pool.query(
      `SELECT * FROM sessions
       WHERE token = $1 AND is_revoked = false AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /**
   * Find session by refresh token
   */
  async findByRefreshToken(refreshToken: string): Promise<Session | null> {
    const result = await pool.query(
      `SELECT * FROM sessions
       WHERE refresh_token = $1 AND is_revoked = false AND refresh_expires_at > NOW()`,
      [refreshToken]
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  /**
   * Update the access token for a session (on refresh)
   */
  async updateToken(sessionId: string, newToken: string): Promise<void> {
    const newExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL);

    await pool.query(
      `UPDATE sessions SET token = $1, expires_at = $2, last_activity_at = NOW()
       WHERE id = $3`,
      [newToken, newExpiresAt, sessionId]
    );
  }

  /**
   * Revoke a single session
   */
  async revoke(token: string): Promise<void> {
    await pool.query(
      `UPDATE sessions SET is_revoked = true WHERE token = $1`,
      [token]
    );
  }

  /**
   * Revoke all sessions for a user (e.g., on password change)
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await pool.query(
      `UPDATE sessions SET is_revoked = true WHERE user_id = $1 AND is_revoked = false
       RETURNING id`,
      [userId]
    );
    return result.rowCount || 0;
  }

  /**
   * Get active sessions for a user
   */
  async getActiveForUser(userId: string): Promise<Session[]> {
    const result = await pool.query(
      `SELECT * FROM sessions
       WHERE user_id = $1 AND is_revoked = false AND expires_at > NOW()
       ORDER BY last_activity_at DESC`,
      [userId]
    );

    return result.rows.map(this.mapRow);
  }

  /**
   * Cleanup expired sessions
   * TODO: this should be a cron job, not called manually
   * Right now it only runs when someone hits the /admin/cleanup endpoint
   * which nobody ever does
   */
  async cleanupExpired(): Promise<number> {
    const result = await pool.query(
      `DELETE FROM sessions WHERE expires_at < NOW() AND refresh_expires_at < NOW()
       RETURNING id`
    );
    return result.rowCount || 0;
  }

  /**
   * Touch session (update last activity)
   */
  async touch(sessionId: string): Promise<void> {
    await pool.query(
      `UPDATE sessions SET last_activity_at = NOW() WHERE id = $1`,
      [sessionId]
    );
  }

  private mapRow(row: any): Session {
    return {
      id: row.id,
      userId: row.user_id,
      token: row.token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      isRevoked: row.is_revoked,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      deviceId: row.device_id,
      clientType: row.client_type,
    };
  }
}
