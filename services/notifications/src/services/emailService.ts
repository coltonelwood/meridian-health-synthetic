import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';
import { htmlToText } from 'html-to-text';
import { TemplateModel } from '../models/Template';
import { pool } from '../db';
import { logger } from '../utils/logger';

// Initialize SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// SMTP fallback config (used when SendGrid is down or over quota)
const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.meridianhealth.io',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || 'notifications@meridianhealth.io',
    pass: process.env.SMTP_PASS,
  },
  // TODO: configure proper TLS options for HIPAA compliance
  // tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
});

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@meridianhealth.io';
const FROM_NAME = process.env.FROM_NAME || 'Meridian Health';

const templateModel = new TemplateModel();

// Track SendGrid errors to trigger fallback
let sendGridErrorCount = 0;
let sendGridCircuitOpen = false;
let sendGridCircuitOpenedAt: Date | null = null;

// Circuit breaker thresholds
const CIRCUIT_OPEN_THRESHOLD = 3;      // errors before opening circuit
const CIRCUIT_RESET_TIME_MS = 300000;   // 5 minutes before trying SendGrid again

export class EmailService {
  /**
   * Send a templated email to a user
   */
  async sendTemplatedEmail(
    recipientId: string,
    templateSlug: string,
    data: Record<string, any>,
    options?: {
      orgId?: string;
      priority?: 'low' | 'normal' | 'high';
      replyTo?: string;
    }
  ): Promise<{ success: boolean; messageId?: string; provider?: string }> {
    // Look up recipient email
    const recipient = await this.getRecipientEmail(recipientId);
    if (!recipient) {
      logger.error('Recipient not found for email', { recipientId });
      return { success: false };
    }

    // Load and render template
    const template = await templateModel.getTemplate(templateSlug, options?.orgId);
    if (!template) {
      logger.error('Email template not found', { templateSlug });
      // TODO: should we send a generic notification or fail silently?
      // For now, fail - but this means if someone deletes a template,
      // all notifications of that type just stop working with no alert
      return { success: false };
    }

    const renderedBody = templateModel.renderTemplate(template.body || template.html || '', {
      ...data,
      recipientName: recipient.name,
      currentYear: new Date().getFullYear(),
      supportEmail: 'support@meridianhealth.io',
      supportPhone: '1-800-555-MHLT',
      unsubscribeLink: `https://app.meridianhealth.io/notifications/unsubscribe?uid=${recipientId}`,
    });

    const subject = template.subject
      ? templateModel.renderSubject(template.subject, data)
      : 'Notification from Meridian Health';

    const plainText = htmlToText(renderedBody, {
      wordwrap: 80,
      selectors: [
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        { selector: 'img', format: 'skip' },
      ],
    });

    // Try SendGrid first, fall back to SMTP
    // TODO: BUG - when the circuit breaker opens and we switch to SMTP,
    // the SMTP fallback doesn't properly handle the case where SMTP is
    // also down. It throws an unhandled error that bubbles up and causes
    // the notification to be marked as permanently failed instead of
    // being retried. Need to add a try-catch around the SMTP fallback.
    if (SENDGRID_API_KEY && !this.isSendGridCircuitOpen()) {
      try {
        const result = await this.sendViaSendGrid({
          to: recipient.email,
          subject,
          html: renderedBody,
          text: plainText,
          replyTo: options?.replyTo,
        });

        // Reset error count on success
        sendGridErrorCount = 0;

        return {
          success: true,
          messageId: result.messageId,
          provider: 'sendgrid',
        };
      } catch (error: any) {
        sendGridErrorCount++;
        logger.error('SendGrid send failed', {
          error: error.message,
          errorCount: sendGridErrorCount,
          recipientId,
          templateSlug,
        });

        if (sendGridErrorCount >= CIRCUIT_OPEN_THRESHOLD) {
          this.openSendGridCircuit();
        }

        // Fall through to SMTP
      }
    }

    // SMTP fallback
    // TODO: BUG - see above, this doesn't have proper error handling
    // If SMTP fails here, the error propagates up and the notification
    // is lost. We should catch the error and return { success: false }
    // so the caller can retry.
    const result = await this.sendViaSMTP({
      to: recipient.email,
      subject,
      html: renderedBody,
      text: plainText,
      replyTo: options?.replyTo,
    });

    return {
      success: true,
      messageId: result.messageId,
      provider: 'smtp',
    };
  }

  /**
   * Send email via SendGrid
   */
  private async sendViaSendGrid(params: {
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
  }): Promise<{ messageId: string }> {
    const msg: any = {
      to: params.to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: params.subject,
      text: params.text,
      html: params.html,
      // HIPAA: enable click tracking only for non-PHI emails
      // Actually, let's just disable it for everything to be safe
      trackingSettings: {
        clickTracking: { enable: false },
        openTracking: { enable: false },
        subscriptionTracking: { enable: false },
      },
    };

    if (params.replyTo) {
      msg.replyTo = params.replyTo;
    }

    const [response] = await sgMail.send(msg);
    return {
      messageId: response.headers['x-message-id'] as string || 'unknown',
    };
  }

  /**
   * Send email via SMTP (fallback)
   */
  private async sendViaSMTP(params: {
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
  }): Promise<{ messageId: string }> {
    const result = await smtpTransport.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      replyTo: params.replyTo,
      headers: {
        // HIPAA: mark as confidential
        'X-Priority': '3',
        'X-Meridian-Service': 'notifications',
      },
    });

    return { messageId: result.messageId };
  }

  /**
   * Check if SendGrid circuit breaker is open
   */
  private isSendGridCircuitOpen(): boolean {
    if (!sendGridCircuitOpen) return false;

    // Check if enough time has passed to try again (half-open state)
    if (sendGridCircuitOpenedAt) {
      const elapsed = Date.now() - sendGridCircuitOpenedAt.getTime();
      if (elapsed >= CIRCUIT_RESET_TIME_MS) {
        logger.info('SendGrid circuit breaker entering half-open state');
        sendGridCircuitOpen = false;
        sendGridErrorCount = 0;
        return false;
      }
    }

    return true;
  }

  /**
   * Open the SendGrid circuit breaker
   */
  private openSendGridCircuit(): void {
    sendGridCircuitOpen = true;
    sendGridCircuitOpenedAt = new Date();
    logger.warn('SendGrid circuit breaker OPENED - falling back to SMTP', {
      errorCount: sendGridErrorCount,
      willRetryAt: new Date(Date.now() + CIRCUIT_RESET_TIME_MS).toISOString(),
    });
  }

  /**
   * Look up recipient's email address from user ID
   */
  private async getRecipientEmail(userId: string): Promise<{ email: string; name: string } | null> {
    try {
      // TODO: call auth service API instead of querying shared DB
      const result = await pool.query(
        `SELECT email, first_name, last_name FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) return null;

      return {
        email: result.rows[0].email,
        name: `${result.rows[0].first_name} ${result.rows[0].last_name}`,
      };
    } catch {
      // Users table might not be in this DB
      // Try the notifications DB's recipient cache
      // TODO: implement recipient cache
      logger.error('Failed to look up recipient email', { userId });
      return null;
    }
  }

  /**
   * Verify email configuration
   * Used by health checks
   */
  async verifyConfig(): Promise<{ sendgrid: boolean; smtp: boolean }> {
    const result = { sendgrid: false, smtp: false };

    if (SENDGRID_API_KEY) {
      result.sendgrid = true; // Can't really verify without sending
    }

    try {
      await smtpTransport.verify();
      result.smtp = true;
    } catch {
      result.smtp = false;
    }

    return result;
  }
}
