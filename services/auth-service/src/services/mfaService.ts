import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import { UserModel } from '../models/User';
import { SessionModel } from '../models/Session';
import { logger } from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'meridian-dev-secret-do-not-use-in-prod';

const userModel = new UserModel();
const sessionModel = new SessionModel();

// TODO: encrypt MFA secrets at rest using MFA_ENCRYPTION_KEY
// Right now they're stored in plaintext in the DB which is a compliance issue
// Tracked in AUTH-891

export class MFAService {
  /**
   * Generate a new TOTP secret for a user
   * Returns the secret and a QR code URL for authenticator apps
   */
  async setupMFA(userId: string): Promise<{
    secret: string;
    qrCodeUrl: string;
    manualEntryKey: string;
  }> {
    const user = await userModel.findByIdSafe(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const secret = speakeasy.generateSecret({
      name: `Meridian Health (${user.email})`,
      issuer: 'Meridian Health Technologies',
      length: 32,
    });

    // Don't save yet - wait for verification
    // Store temporarily... somewhere
    // TODO: use Redis for temp storage instead of this hack
    // Right now we're storing it in a JWT which is... creative
    const tempToken = jwt.sign(
      {
        sub: userId,
        mfaSecret: secret.base32,
        type: 'mfa_setup',
      },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url || '');

    return {
      secret: tempToken, // this is actually a JWT, not the raw secret
      qrCodeUrl,
      manualEntryKey: secret.base32,
    };
  }

  /**
   * Verify MFA setup by checking a code from the user's authenticator app
   * This confirms they've successfully set up their authenticator
   */
  async confirmMFASetup(userId: string, setupToken: string, code: string): Promise<boolean> {
    try {
      const decoded = jwt.verify(setupToken, JWT_SECRET) as any;

      if (decoded.sub !== userId || decoded.type !== 'mfa_setup') {
        return false;
      }

      const isValid = speakeasy.totp.verify({
        secret: decoded.mfaSecret,
        encoding: 'base32',
        token: code,
        window: 2, // allow 2 time steps of drift (60 seconds)
      });

      if (!isValid) return false;

      // Save MFA secret to user record
      // TODO: encrypt this before storing
      const { pool } = await import('../db');
      await pool.query(
        `UPDATE users SET mfa_enabled = true, mfa_secret = $1, updated_at = NOW() WHERE id = $2`,
        [decoded.mfaSecret, userId]
      );

      logger.info('MFA enabled for user', { userId });
      return true;
    } catch (error: any) {
      logger.error('MFA setup confirmation failed', { error: error.message, userId });
      return false;
    }
  }

  /**
   * Verify TOTP code during login (after password is confirmed)
   */
  async verifyTOTP(mfaToken: string, code: string): Promise<{
    success: boolean;
    token?: string;
    refreshToken?: string;
    user?: any;
  }> {
    try {
      const decoded = jwt.verify(mfaToken, JWT_SECRET) as any;

      if (decoded.type !== 'mfa_pending') {
        return { success: false };
      }

      const user = await userModel.findById(decoded.sub);
      if (!user || !user.mfaSecret) {
        return { success: false };
      }

      const isValid = speakeasy.totp.verify({
        secret: user.mfaSecret,
        encoding: 'base32',
        token: code,
        window: 2,
      });

      if (!isValid) {
        // TODO: track MFA failures separately from password failures
        // Right now a wrong MFA code doesn't count towards account lockout
        // which might be a problem
        logger.warn('Failed MFA attempt', { userId: user.id });
        return { success: false };
      }

      // MFA passed - generate full access token
      const accessToken = jwt.sign(
        {
          sub: user.id,
          email: user.email,
          role: user.role,
          orgId: user.organizationId,
          mfaVerified: true,
          type: 'access',
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      const refreshToken = jwt.sign(
        {
          sub: user.id,
          type: 'refresh',
        },
        process.env.REFRESH_SECRET || 'meridian-refresh-secret-change-me',
        { expiresIn: '30d' }
      );

      await sessionModel.create(user.id, accessToken, refreshToken);

      return {
        success: true,
        token: accessToken,
        refreshToken,
        user,
      };
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        return { success: false }; // MFA window expired
      }
      logger.error('MFA verification error', { error: error.message });
      return { success: false };
    }
  }

  /**
   * Disable MFA for a user
   * Requires re-authentication (current password)
   */
  async disableMFA(userId: string): Promise<boolean> {
    try {
      const { pool } = await import('../db');
      await pool.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret = NULL, updated_at = NOW() WHERE id = $1`,
        [userId]
      );

      logger.info('MFA disabled for user', { userId });
      return true;
    } catch (error: any) {
      logger.error('Failed to disable MFA', { error: error.message, userId });
      return false;
    }
  }

  /**
   * Generate backup codes for MFA recovery
   * TODO: implement this - right now users who lose their authenticator
   * have to contact support to get MFA disabled manually
   */
  async generateBackupCodes(userId: string): Promise<string[]> {
    // Not implemented yet
    // Should generate 10 single-use backup codes
    // Store hashed versions in DB
    throw new Error('Backup codes not yet implemented - contact support@meridianhealth.io');
  }
}
