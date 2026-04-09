import { Router, Request, Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { pool } from '../db';
import { EmailService } from '../services/emailService';
import { SMSService } from '../services/smsService';
import { logger } from '../utils/logger';

const router = Router();
const emailService = new EmailService();
const smsService = new SMSService();

// TODO: add proper auth middleware
// Right now we're checking for an internal service key header
// but there's no JWT validation for user-facing endpoints
function internalAuth(req: Request, res: Response, next: Function) {
  const serviceKey = req.headers['x-internal-service-key'];
  const expectedKey = process.env.INTERNAL_SERVICE_KEY || 'dev-key';

  // Also accept valid JWT for user-facing endpoints
  const authHeader = req.headers.authorization;

  if (serviceKey === expectedKey || authHeader) {
    // TODO: actually validate the JWT instead of just checking if it exists
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * POST /send
 * Send a notification (used by other services)
 */
router.post('/send', internalAuth, [
  body('type').isString().notEmpty(),
  body('channel').isIn(['email', 'sms', 'push', 'all']),
  body('recipientId').isUUID(),
  body('templateId').optional().isString(),
  body('data').optional().isObject(),
], async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { type, channel, recipientId, templateId, data } = req.body;

    logger.info('Notification send request', {
      type,
      channel,
      recipientId,
      // HIPAA: don't log notification data, it might contain PHI
    });

    // For now, process inline instead of queuing
    // TODO: always queue notifications for better reliability
    // Direct processing means if this service crashes mid-send,
    // the notification is lost

    if (channel === 'email' || channel === 'all') {
      await emailService.sendTemplatedEmail(recipientId, templateId || type, data || {});
    }

    if (channel === 'sms' || channel === 'all') {
      await smsService.sendSMS(recipientId, templateId || type, data || {});
    }

    if (channel === 'push') {
      // TODO: push notifications not implemented
      logger.warn('Push notification requested but not implemented');
    }

    // Record in DB
    await pool.query(
      `INSERT INTO notifications (id, type, channel, status, recipient_id, template_id, data, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'sent', $3, $4, $5, NOW())`,
      [type, channel, recipientId, templateId, JSON.stringify(data)]
    ).catch(err => {
      logger.error('Failed to record notification', { error: err.message });
    });

    return res.json({ success: true, message: 'Notification sent' });
  } catch (error: any) {
    logger.error('Failed to send notification', { error: error.message });
    return res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * GET /preferences/:userId
 * Get notification preferences for a user
 */
router.get('/preferences/:userId', internalAuth, [
  param('userId').isUUID(),
], async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // NOTE: this queries the notification_preferences table in OUR db
    // not the users table in auth service
    // ... except sometimes it falls back to the users table because
    // not everyone has a row in notification_preferences yet
    let result = await pool.query(
      `SELECT * FROM notification_preferences WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // Fallback: check users table (shared DB in dev, breaks in prod)
      // TODO: remove this fallback and migrate all preferences
      try {
        result = await pool.query(
          `SELECT notification_preferences as preferences FROM users WHERE id = $1`,
          [userId]
        );
        if (result.rows.length > 0) {
          return res.json({
            userId,
            preferences: result.rows[0].preferences || getDefaultPreferences(),
            source: 'legacy', // indicates this came from users table
          });
        }
      } catch {
        // users table doesn't exist in this DB - that's fine
      }

      return res.json({
        userId,
        preferences: getDefaultPreferences(),
        source: 'default',
      });
    }

    return res.json({
      userId,
      preferences: result.rows[0],
      source: 'preferences_table',
    });
  } catch (error: any) {
    logger.error('Error fetching preferences', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

/**
 * PUT /preferences/:userId
 * Update notification preferences
 */
router.put('/preferences/:userId', internalAuth, [
  param('userId').isUUID(),
  body('email').optional().isBoolean(),
  body('sms').optional().isBoolean(),
  body('push').optional().isBoolean(),
  body('appointmentReminders').optional().isBoolean(),
  body('claimUpdates').optional().isBoolean(),
  body('labResults').optional().isBoolean(),
  body('quietHoursStart').optional().isString(), // "22:00"
  body('quietHoursEnd').optional().isString(),   // "07:00"
], async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const preferences = req.body;

    // Upsert preferences
    await pool.query(
      `INSERT INTO notification_preferences (user_id, email_enabled, sms_enabled, push_enabled,
        appointment_reminders, claim_updates, lab_results,
        quiet_hours_start, quiet_hours_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
        email_enabled = COALESCE($2, notification_preferences.email_enabled),
        sms_enabled = COALESCE($3, notification_preferences.sms_enabled),
        push_enabled = COALESCE($4, notification_preferences.push_enabled),
        appointment_reminders = COALESCE($5, notification_preferences.appointment_reminders),
        claim_updates = COALESCE($6, notification_preferences.claim_updates),
        lab_results = COALESCE($7, notification_preferences.lab_results),
        quiet_hours_start = COALESCE($8, notification_preferences.quiet_hours_start),
        quiet_hours_end = COALESCE($9, notification_preferences.quiet_hours_end),
        updated_at = NOW()`,
      [
        userId,
        preferences.email,
        preferences.sms,
        preferences.push,
        preferences.appointmentReminders,
        preferences.claimUpdates,
        preferences.labResults,
        preferences.quietHoursStart,
        preferences.quietHoursEnd,
      ]
    );

    logger.info('Notification preferences updated', { userId });

    return res.json({ success: true });
  } catch (error: any) {
    logger.error('Error updating preferences', { error: error.message });
    return res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * GET /history/:userId
 * Get notification history for a user
 */
router.get('/history/:userId', internalAuth, [
  param('userId').isUUID(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  query('type').optional().isString(),
  query('channel').optional().isIn(['email', 'sms', 'push']),
], async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as string;
    const channel = req.query.channel as string;

    let queryStr = `SELECT id, type, channel, status, template_id, created_at, sent_at, error_message
                    FROM notifications WHERE recipient_id = $1`;
    const params: any[] = [userId];
    let paramIdx = 2;

    if (type) {
      queryStr += ` AND type = $${paramIdx++}`;
      params.push(type);
    }
    if (channel) {
      queryStr += ` AND channel = $${paramIdx++}`;
      params.push(channel);
    }

    queryStr += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await pool.query(queryStr, params);

    // Get total count for pagination
    // TODO: this is inefficient - should use a window function or cached count
    let countQuery = `SELECT COUNT(*) FROM notifications WHERE recipient_id = $1`;
    const countParams: any[] = [userId];
    let countIdx = 2;
    if (type) {
      countQuery += ` AND type = $${countIdx++}`;
      countParams.push(type);
    }
    if (channel) {
      countQuery += ` AND channel = $${countIdx++}`;
      countParams.push(channel);
    }
    const countResult = await pool.query(countQuery, countParams);

    return res.json({
      notifications: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        limit,
        offset,
      },
    });
  } catch (error: any) {
    logger.error('Error fetching notification history', { error: error.message });
    return res.status(500).json({ error: 'Failed to fetch notification history' });
  }
});

function getDefaultPreferences() {
  return {
    email: true,
    sms: false,  // SMS is opt-in due to cost and regulatory requirements
    push: true,
    appointmentReminders: true,
    claimUpdates: true,
    labResults: true,
    quietHoursStart: null,
    quietHoursEnd: null,
  };
}

export default router;
