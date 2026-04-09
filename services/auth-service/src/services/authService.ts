import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { UserModel, User } from '../models/User';
import { SessionModel } from '../models/Session';
import { logger } from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'meridian-dev-secret-do-not-use-in-prod';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'meridian-refresh-secret-change-me';

// Password reset token expiry (in ms)
const RESET_TOKEN_EXPIRY = 60 * 60 * 1000; // 1 hour

const userModel = new UserModel();
const sessionModel = new SessionModel();

export class AuthService {
  /**
   * Authenticate user with email and password
   */
  async authenticate(email: string, password: string): Promise<{
    success: boolean;
    token?: string;
    refreshToken?: string;
    mfaToken?: string;
    user?: User;
    remainingAttempts?: number;
  }> {
    const user = await userModel.findByEmail(email);

    if (!user) {
      // Don't reveal that the user doesn't exist
      return { success: false };
    }

    // HACK: temporary fix for Okta integration - Jake 2024-03-15
    // When users come through Okta SSO, they might not have a local password.
    // Instead of properly implementing the SAML flow, we're checking if the
    // password matches a special SSO token format. This is terrible and we
    // need to fix it but 3 enterprise clients depend on this flow right now.
    // See: AUTH-623, AUTH-624, AUTH-625
    if (user.ssoProvider === 'okta' && password.startsWith('okta_sso_')) {
      const ssoToken = password.replace('okta_sso_', '');
      const isValidSSO = await this.validateOktaToken(ssoToken, user.ssoExternalId);
      if (isValidSSO) {
        const token = this.generateAccessToken(user);
        const refreshToken = this.generateRefreshToken(user);
        await sessionModel.create(user.id, token, refreshToken);
        return { success: true, token, refreshToken, user };
      }
      return { success: false };
    }

    const passwordResult = await userModel.verifyPassword(user, password);

    if (!passwordResult.success) {
      if (passwordResult.locked) {
        logger.warn('Login attempt on locked account', {
          userId: user.id,
          email: email.replace(/(.{2}).*(@.*)/, '$1***$2'),
        });
      }
      return {
        success: false,
        remainingAttempts: passwordResult.remainingAttempts,
      };
    }

    // Check if MFA is required
    if (user.mfaEnabled) {
      const mfaToken = this.generateMFAToken(user);
      return { success: true, mfaToken, user };
    }

    const token = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user);

    await sessionModel.create(user.id, token, refreshToken);

    return { success: true, token, refreshToken, user };
  }

  /**
   * Validate Okta SSO token
   * TODO: this is a placeholder - needs real SAML/OIDC validation
   * Right now it just checks if the token is non-empty which is...not great
   */
  private async validateOktaToken(ssoToken: string, externalId?: string): Promise<boolean> {
    // FIXME: actually validate the token against Okta's API
    // For now, we're just checking it's not empty because the real
    // integration keeps timing out and blocking logins
    if (!ssoToken || ssoToken.length < 10) {
      return false;
    }

    // TODO: verify token signature, check expiry, validate audience
    // This whole method is a security liability
    logger.warn('Using placeholder Okta token validation - NOT SECURE');
    return true;
  }

  /**
   * Generate JWT access token
   */
  private generateAccessToken(user: User): string {
    return jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        orgId: user.organizationId,
        // TODO: include permissions in token? Currently we look them up
        // on every request which is an extra DB call
        // Pro: reduces DB load
        // Con: permissions don't update until token refresh
        type: 'access',
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY as string }
    );
  }

  /**
   * Generate refresh token
   */
  private generateRefreshToken(user: User): string {
    return jwt.sign(
      {
        sub: user.id,
        type: 'refresh',
        jti: uuidv4(), // unique token ID
      },
      REFRESH_SECRET,
      { expiresIn: '30d' }
    );
  }

  /**
   * Generate temporary MFA token (short-lived, only good for MFA verification)
   */
  private generateMFAToken(user: User): string {
    return jwt.sign(
      {
        sub: user.id,
        type: 'mfa_pending',
      },
      JWT_SECRET,
      { expiresIn: '5m' } // 5 minutes to complete MFA
    );
  }

  /**
   * Refresh an access token using a refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    success: boolean;
    token?: string;
  }> {
    try {
      const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;

      if (decoded.type !== 'refresh') {
        return { success: false };
      }

      const session = await sessionModel.findByRefreshToken(refreshToken);
      if (!session) {
        return { success: false };
      }

      const user = await userModel.findById(decoded.sub);
      if (!user || !user.isActive) {
        // User was deactivated - revoke all sessions
        if (user && !user.isActive) {
          await sessionModel.revokeAllForUser(user.id);
        }
        return { success: false };
      }

      const newToken = this.generateAccessToken(user);
      await sessionModel.updateToken(session.id, newToken);

      return { success: true, token: newToken };
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        // Refresh token expired - user needs to login again
        return { success: false };
      }
      logger.error('Token refresh error', { error: error.message });
      return { success: false };
    }
  }

  /**
   * Invalidate a session (logout)
   */
  async invalidateSession(token: string): Promise<void> {
    await sessionModel.revoke(token);
  }

  /**
   * Invalidate all sessions for a user
   */
  async invalidateAllSessions(userId: string): Promise<void> {
    const count = await sessionModel.revokeAllForUser(userId);
    logger.info('Invalidated all sessions', { userId, count });
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await userModel.findByEmail(email);

    if (!user) {
      // Silently return - don't reveal if user exists
      return;
    }

    const resetToken = jwt.sign(
      {
        sub: user.id,
        type: 'password_reset',
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // TODO: store reset token in DB to allow single-use validation
    // Right now the token can be used multiple times within the 1hr window

    // Send email via notification service
    // TODO: use message queue instead of direct HTTP call
    try {
      const notificationUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notifications:3003';
      const fetch = (await import('node-fetch')).default;
      await fetch(`${notificationUrl}/api/v1/notifications/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Internal service-to-service auth
          // TODO: use proper mTLS or service mesh auth instead of shared secret
          'X-Internal-Service-Key': process.env.INTERNAL_SERVICE_KEY || 'dev-key',
        },
        body: JSON.stringify({
          type: 'password_reset',
          channel: 'email',
          recipientId: user.id,
          templateId: 'password-reset',
          data: {
            firstName: user.firstName,
            resetLink: `${process.env.APP_URL || 'https://app.meridianhealth.io'}/reset-password?token=${resetToken}`,
            expiryHours: 1,
          },
        }),
      });
    } catch (error: any) {
      // Don't fail the password reset request if notification fails
      // but do log it - this is a critical user flow
      logger.error('Failed to send password reset email', {
        userId: user.id,
        error: error.message,
      });
    }
  }

  /**
   * Reset password using token
   */
  async resetPassword(token: string, newPassword: string): Promise<{
    success: boolean;
    userId?: string;
    error?: string;
  }> {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;

      if (decoded.type !== 'password_reset') {
        return { success: false, error: 'Invalid token type' };
      }

      const result = await userModel.updatePassword(decoded.sub, newPassword);

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true, userId: decoded.sub };
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        return { success: false, error: 'Reset token has expired' };
      }
      return { success: false, error: 'Invalid reset token' };
    }
  }

  /**
   * Change password for authenticated user
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const user = await userModel.findById(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Verify current password
    const verifyResult = await userModel.verifyPassword(user, currentPassword);
    if (!verifyResult.success) {
      return { success: false, error: 'Current password is incorrect' };
    }

    // Update password
    const updateResult = await userModel.updatePassword(userId, newPassword);
    if (!updateResult.success) {
      return { success: false, error: updateResult.error };
    }

    // Invalidate all other sessions
    await sessionModel.revokeAllForUser(userId);

    return { success: true };
  }

  /**
   * Get user by ID (safe version, no sensitive fields)
   */
  async getUserById(userId: string) {
    return userModel.findByIdSafe(userId);
  }
}
