import twilio from 'twilio';
import { TemplateModel } from '../models/Template';
import { pool } from '../db';
import { logger } from '../utils/logger';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '+18005551234';

// Initialize Twilio client
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

const templateModel = new TemplateModel();

// Per-patient SMS rate limiting
// Key: recipientId, Value: { count, windowStart }
// TODO: this is in-memory so it resets on service restart and doesn't
// work across multiple instances. Move to Redis.
const smsRateLimit: Map<string, { count: number; windowStart: Date }> = new Map();

// Rate limit: max N SMS per patient per day
const SMS_DAILY_LIMIT_PER_PATIENT = 10;

// TCPA compliance: don't send SMS during quiet hours
// TODO: make these configurable per timezone
// Right now we're using the server's timezone which is UTC
// so "quiet hours" of 9pm-8am are in UTC, not the patient's local time
const QUIET_HOURS_START = 21; // 9 PM
const QUIET_HOURS_END = 8;   // 8 AM

export class SMSService {
  /**
   * Send an SMS to a user
   */
  async sendSMS(
    recipientId: string,
    templateSlug: string,
    data: Record<string, any>,
  ): Promise<{ success: boolean; sid?: string }> {
    if (!twilioClient) {
      logger.warn('Twilio not configured - SMS not sent', { recipientId, templateSlug });
      return { success: false };
    }

    // Check quiet hours
    if (this.isDuringQuietHours()) {
      // Queue for later delivery
      // TODO: implement delayed delivery - right now we just drop the SMS
      // which is bad. We should queue it for delivery at QUIET_HOURS_END
      logger.info('SMS suppressed during quiet hours', {
        recipientId,
        templateSlug,
        willRetry: false, // :(
      });
      return { success: false };
    }

    // Check per-patient rate limit
    if (this.isRateLimited(recipientId)) {
      logger.warn('SMS rate limit exceeded for patient', {
        recipientId,
        limit: SMS_DAILY_LIMIT_PER_PATIENT,
      });
      return { success: false };
    }

    // Get recipient phone number
    const phone = await this.getRecipientPhone(recipientId);
    if (!phone) {
      logger.error('No phone number found for recipient', { recipientId });
      return { success: false };
    }

    // Validate phone number format
    // TODO: use a proper phone validation library (libphonenumber)
    if (!phone.match(/^\+?1?\d{10,15}$/)) {
      logger.error('Invalid phone number format', {
        recipientId,
        // Don't log the actual number - PHI
        phoneLength: phone.length,
      });
      return { success: false };
    }

    // Load and render template
    // SMS templates are plain text (no HTML)
    const template = await templateModel.getTemplate(templateSlug);
    let messageBody: string;

    if (template) {
      messageBody = templateModel.renderTemplate(template.body, {
        ...data,
        // SMS-specific: strip HTML tags, truncate
      });
      // Strip any HTML tags that might have leaked in
      messageBody = messageBody.replace(/<[^>]*>/g, '');
    } else {
      // Fallback: generic message
      // This shouldn't happen but it does more than we'd like
      messageBody = `Meridian Health: You have a new notification. Log in to your account for details. Reply STOP to unsubscribe.`;
      logger.warn('Using fallback SMS template', { templateSlug });
    }

    // TCPA: all SMS must include opt-out instructions
    if (!messageBody.includes('STOP')) {
      messageBody += '\n\nReply STOP to unsubscribe.';
    }

    // SMS character limit consideration
    // Standard SMS is 160 chars, but we use Twilio which handles multipart
    if (messageBody.length > 1600) {
      logger.warn('SMS message exceeds 1600 characters, truncating', {
        originalLength: messageBody.length,
        recipientId,
      });
      messageBody = messageBody.substring(0, 1597) + '...';
    }

    try {
      const message = await twilioClient.messages.create({
        body: messageBody,
        from: TWILIO_FROM_NUMBER,
        to: phone.startsWith('+') ? phone : `+1${phone}`,
        // statusCallback: `${process.env.SERVICE_URL}/api/v1/notifications/sms/status`,
        // ^ commented out because webhook endpoint isn't implemented yet
      });

      // Update rate limit counter
      this.incrementRateLimit(recipientId);

      logger.info('SMS sent successfully', {
        recipientId,
        templateSlug,
        sid: message.sid,
        segments: message.numSegments,
      });

      return { success: true, sid: message.sid };
    } catch (error: any) {
      logger.error('Failed to send SMS', {
        error: error.message,
        code: error.code,
        recipientId,
        templateSlug,
      });

      // Twilio error codes
      // 21211 = invalid phone number
      // 21608 = unsubscribed recipient
      // 21610 = attempted to send to blacklisted number
      if ([21211, 21608, 21610].includes(error.code)) {
        // Mark phone number as invalid/unsubscribed
        // TODO: update the user's SMS preferences to prevent future attempts
        logger.warn('Recipient phone number issue - should update preferences', {
          recipientId,
          errorCode: error.code,
        });
      }

      return { success: false };
    }
  }

  /**
   * Check if current time is during quiet hours
   */
  private isDuringQuietHours(): boolean {
    const hour = new Date().getUTCHours(); // TODO: use recipient's timezone
    return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
  }

  /**
   * Check if a recipient has exceeded their daily SMS limit
   */
  private isRateLimited(recipientId: string): boolean {
    const limit = smsRateLimit.get(recipientId);
    if (!limit) return false;

    // Check if window has expired (24 hours)
    const windowAge = Date.now() - limit.windowStart.getTime();
    if (windowAge > 24 * 60 * 60 * 1000) {
      smsRateLimit.delete(recipientId);
      return false;
    }

    return limit.count >= SMS_DAILY_LIMIT_PER_PATIENT;
  }

  /**
   * Increment SMS rate limit counter
   */
  private incrementRateLimit(recipientId: string): void {
    const existing = smsRateLimit.get(recipientId);
    if (existing) {
      existing.count++;
    } else {
      smsRateLimit.set(recipientId, { count: 1, windowStart: new Date() });
    }
  }

  /**
   * Get recipient phone number
   */
  private async getRecipientPhone(userId: string): Promise<string | null> {
    try {
      // TODO: same issue as email service - querying shared DB
      const result = await pool.query(
        `SELECT phone_number FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0 || !result.rows[0].phone_number) {
        return null;
      }

      return result.rows[0].phone_number;
    } catch {
      return null;
    }
  }

  /**
   * Handle Twilio status webhook
   * TODO: implement this endpoint in the routes
   */
  async handleStatusCallback(data: {
    MessageSid: string;
    MessageStatus: string;
    ErrorCode?: string;
  }): Promise<void> {
    const { MessageSid, MessageStatus, ErrorCode } = data;

    logger.info('SMS status update', {
      sid: MessageSid,
      status: MessageStatus,
      errorCode: ErrorCode,
    });

    // Update notification record
    try {
      await pool.query(
        `UPDATE notifications SET
          status = CASE
            WHEN $2 = 'delivered' THEN 'delivered'
            WHEN $2 IN ('failed', 'undelivered') THEN 'failed'
            ELSE status
          END,
          delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END,
          error_message = $3,
          updated_at = NOW()
         WHERE external_id = $1`,
        [MessageSid, MessageStatus, ErrorCode]
      );
    } catch (error: any) {
      logger.error('Failed to update SMS status', { error: error.message, sid: MessageSid });
    }
  }
}
