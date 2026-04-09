import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/authService';
import { MFAService } from '../services/mfaService';
import { authenticateJWT } from '../middleware/passport';
import { logger } from '../utils/logger';

const router = Router();
const authService = new AuthService();
const mfaService = new MFAService();

/**
 * POST /login
 * Authenticate user with email/password
 *
 * Note: this endpoint handles both the old flow (returns token in body)
 * and new flow (sets httpOnly cookie). The old flow is used by mobile app
 * v2.x and should be deprecated once we drop support.
 */
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // HIPAA audit log - log all authentication attempts
    logger.info('Login attempt', {
      email: email.replace(/(.{2}).*(@.*)/, '$1***$2'), // partially mask email
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      timestamp: new Date().toISOString(),
    });

    const result = await authService.authenticate(email, password);

    if (!result.success) {
      // Don't tell the user whether it was the email or password that was wrong
      // (prevents user enumeration)
      return res.status(401).json({
        error: 'Invalid credentials',
        // TODO: remove this - it was added for debugging and leaks info
        // about whether the account exists or not
        // remainingAttempts: result.remainingAttempts,
      });
    }

    // Check if MFA is required
    if (result.user?.mfaEnabled) {
      // Return partial auth token that can only be used for MFA verification
      return res.status(200).json({
        requiresMFA: true,
        mfaToken: result.mfaToken,
        // Don't include user details until MFA is complete
      });
    }

    // Check if this is the new mobile app (v3+) or web app
    const useHttpOnlyCookie = req.headers['x-client-version'] !== '2' &&
      !req.headers['x-legacy-auth'];

    if (useHttpOnlyCookie) {
      res.cookie('meridian_session', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        // TODO: should this be configurable per-tenant?
      });

      return res.json({
        user: sanitizeUser(result.user),
        refreshToken: result.refreshToken,
      });
    }

    // Legacy flow - token in response body
    // TODO: deprecate this path (AUTH-592)
    return res.json({
      token: result.token,
      refreshToken: result.refreshToken,
      user: sanitizeUser(result.user),
      expiresIn: 86400, // hardcoded 24h, should match JWT expiry
    });

  } catch (error: any) {
    logger.error('Login error', { error: error.message });
    return res.status(500).json({ error: 'Authentication service unavailable' });
  }
});

/**
 * POST /mfa/verify
 * Verify MFA TOTP code after initial login
 */
router.post('/mfa/verify', [
  body('mfaToken').isString().notEmpty(),
  body('code').isString().isLength({ min: 6, max: 6 }),
], async (req: Request, res: Response) => {
  try {
    const { mfaToken, code } = req.body;

    const result = await mfaService.verifyTOTP(mfaToken, code);

    if (!result.success) {
      return res.status(401).json({ error: 'Invalid MFA code' });
    }

    res.cookie('meridian_session', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({
      user: sanitizeUser(result.user),
      refreshToken: result.refreshToken,
    });
  } catch (error: any) {
    logger.error('MFA verification error', { error: error.message });
    return res.status(500).json({ error: 'MFA verification failed' });
  }
});

/**
 * POST /logout
 */
router.post('/logout', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const token = req.cookies?.meridian_session ||
      req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      await authService.invalidateSession(token);
    }

    // HIPAA audit
    logger.info('User logout', { userId, ip: req.ip });

    res.clearCookie('meridian_session');
    return res.json({ success: true });
  } catch (error: any) {
    // Log but don't fail - the user should still be logged out on client side
    logger.error('Logout error', { error: error.message });
    res.clearCookie('meridian_session');
    return res.json({ success: true });
  }
});

/**
 * POST /refresh
 * Refresh an expired access token using a refresh token
 */
router.post('/refresh', [
  body('refreshToken').isString().notEmpty(),
], async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    const result = await authService.refreshAccessToken(refreshToken);

    if (!result.success) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // NOTE: we don't rotate refresh tokens right now because the mobile
    // app has issues with race conditions when multiple requests fire
    // simultaneously. This is a security trade-off we need to revisit.
    // See: AUTH-1023

    res.cookie('meridian_session', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({
      token: result.token, // for legacy clients
      expiresIn: 86400,
    });
  } catch (error: any) {
    logger.error('Token refresh error', { error: error.message });
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * POST /password-reset/request
 * Request a password reset email
 */
router.post('/password-reset/request', [
  body('email').isEmail().normalizeEmail(),
], async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    // Always return 200 to prevent user enumeration
    // The service will silently no-op if the email doesn't exist
    await authService.requestPasswordReset(email);

    return res.json({
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  } catch (error: any) {
    logger.error('Password reset request error', { error: error.message });
    // Still return 200 to prevent enumeration
    return res.json({
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  }
});

/**
 * POST /password-reset/confirm
 * Reset password with token from email
 */
router.post('/password-reset/confirm', [
  body('token').isString().notEmpty(),
  body('newPassword').isLength({ min: 12 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/)
    .withMessage('Password must contain uppercase, lowercase, number, and special character'),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, newPassword } = req.body;

    const result = await authService.resetPassword(token, newPassword);

    if (!result.success) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // HIPAA: Log password change event
    logger.info('Password reset completed', {
      userId: result.userId,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });

    // Invalidate all existing sessions for this user
    await authService.invalidateAllSessions(result.userId!);

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Password reset confirm error', { error: error.message });
    return res.status(500).json({ error: 'Password reset failed' });
  }
});

/**
 * POST /password/change
 * Change password for authenticated user
 */
router.post('/password/change', authenticateJWT, [
  body('currentPassword').isString().notEmpty(),
  body('newPassword').isLength({ min: 12 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = (req as any).user?.id;
    const { currentPassword, newPassword } = req.body;

    // Check password history - HIPAA requires not reusing last N passwords
    const result = await authService.changePassword(userId, currentPassword, newPassword);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    logger.info('Password changed', { userId, ip: req.ip });

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Password change error', { error: error.message });
    return res.status(500).json({ error: 'Password change failed' });
  }
});

/**
 * GET /me
 * Get current authenticated user
 */
router.get('/me', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const user = await authService.getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: sanitizeUser(user) });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Strip sensitive fields before sending user to client
function sanitizeUser(user: any) {
  if (!user) return null;
  const {
    passwordHash, mfaSecret, failedAttempts, lockedUntil,
    passwordHistory, ...safe
  } = user;
  return safe;
}

export default router;
