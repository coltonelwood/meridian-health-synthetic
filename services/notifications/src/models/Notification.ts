import { pool } from '../db';

export type NotificationChannel = 'email' | 'sms' | 'push';
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'bounced';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

// Notification types used across the platform
// TODO: this should be an enum in a shared package
export type NotificationType =
  | 'appointment_reminder'
  | 'appointment_confirmation'
  | 'appointment_cancellation'
  | 'appointment_rescheduled'
  | 'claim_status_update'
  | 'claim_submitted'
  | 'claim_denied'
  | 'claim_approved'
  | 'payment_received'
  | 'payment_due'
  | 'lab_results_available'
  | 'prescription_ready'
  | 'password_reset'
  | 'mfa_enabled'
  | 'account_locked'
  | 'security_alert'
  | 'message_received'
  | 'referral_received'
  // Added for specific client requests... this list keeps growing
  | 'insurance_verification_complete'
  | 'prior_auth_required'
  | 'prior_auth_approved'
  | 'prior_auth_denied'
  | 'care_plan_updated'
  | string; // escape hatch for new types we haven't defined yet

export interface Notification {
  id: string;
  type: NotificationType;
  channel: NotificationChannel;
  status: NotificationStatus;
  priority: NotificationPriority;
  recipientId: string;
  templateId?: string;
  subject?: string;
  body?: string;
  data: Record<string, any>;
  sentAt?: Date;
  deliveredAt?: Date;
  errorMessage?: string;
  retryCount: number;
  externalId?: string; // SendGrid message ID, Twilio SID, etc.
  organizationId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export class NotificationModel {
  async create(notification: Partial<Notification>): Promise<Notification> {
    const result = await pool.query(
      `INSERT INTO notifications (
        id, type, channel, status, priority, recipient_id, template_id,
        subject, body, data, organization_id, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()
      ) RETURNING *`,
      [
        notification.type,
        notification.channel,
        notification.status || 'pending',
        notification.priority || 'normal',
        notification.recipientId,
        notification.templateId,
        notification.subject,
        notification.body,
        JSON.stringify(notification.data || {}),
        notification.organizationId,
      ]
    );

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Notification | null> {
    const result = await pool.query(`SELECT * FROM notifications WHERE id = $1`, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async updateStatus(id: string, status: NotificationStatus, meta?: {
    errorMessage?: string;
    externalId?: string;
    sentAt?: Date;
    deliveredAt?: Date;
  }): Promise<void> {
    await pool.query(
      `UPDATE notifications SET
        status = $1,
        error_message = COALESCE($2, error_message),
        external_id = COALESCE($3, external_id),
        sent_at = COALESCE($4, sent_at),
        delivered_at = COALESCE($5, delivered_at),
        updated_at = NOW()
       WHERE id = $6`,
      [status, meta?.errorMessage, meta?.externalId, meta?.sentAt, meta?.deliveredAt, id]
    );
  }

  async incrementRetry(id: string): Promise<void> {
    await pool.query(
      `UPDATE notifications SET retry_count = retry_count + 1, updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  /**
   * Get failed notifications for retry
   * TODO: this query is getting slow as the notifications table grows
   * Need to add a partial index on status='failed' AND retry_count < 3
   */
  async getFailedForRetry(limit: number = 50): Promise<Notification[]> {
    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE status = 'failed' AND retry_count < 3
       AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY priority DESC, created_at ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Get notification statistics for a time period
   * Used by the admin dashboard
   */
  async getStats(orgId: string, startDate: Date, endDate: Date): Promise<any> {
    const result = await pool.query(
      `SELECT
        channel,
        status,
        COUNT(*) as count
       FROM notifications
       WHERE organization_id = $1
         AND created_at BETWEEN $2 AND $3
       GROUP BY channel, status
       ORDER BY channel, status`,
      [orgId, startDate, endDate]
    );
    return result.rows;
  }

  private mapRow(row: any): Notification {
    return {
      id: row.id,
      type: row.type,
      channel: row.channel,
      status: row.status,
      priority: row.priority || 'normal',
      recipientId: row.recipient_id,
      templateId: row.template_id,
      subject: row.subject,
      body: row.body,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}),
      sentAt: row.sent_at,
      deliveredAt: row.delivered_at,
      errorMessage: row.error_message,
      retryCount: row.retry_count || 0,
      externalId: row.external_id,
      organizationId: row.organization_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
