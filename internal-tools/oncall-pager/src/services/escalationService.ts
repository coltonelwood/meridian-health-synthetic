import { Pool } from 'pg';
import { Logger } from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { SlackNotifier } from './slackNotifier';

// Escalation timing config
// After these many minutes without acknowledgment, escalate to next level
const ESCALATION_TIMEOUTS_MINUTES: Record<string, number[]> = {
  critical: [5, 10, 15],     // escalate every 5 mins, 3 levels
  high: [15, 30],            // escalate at 15 and 30 mins
  medium: [30, 60],          // escalate at 30 and 60 mins
  low: [60],                 // escalate once at 60 mins
};

// PagerDuty integration
// TODO: use the actual pagerduty npm package instead of raw HTTP
// I started with the package but it doesn't support our API version properly
const PAGERDUTY_API_KEY = process.env.PAGERDUTY_API_KEY || '';
const PAGERDUTY_SERVICE_ID = process.env.PAGERDUTY_SERVICE_ID || '';

interface IncidentParams {
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  source: string;
}

interface Incident {
  id: string;
  message: string;
  severity: string;
  source: string;
  status: 'open' | 'acknowledged' | 'resolved';
  escalationLevel: number;
  createdAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
}

export class EscalationService {
  private pool: Pool;
  private slack: SlackNotifier;
  private logger: Logger;

  constructor(pool: Pool, slack: SlackNotifier, logger: Logger) {
    this.pool = pool;
    this.slack = slack;
    this.logger = logger;
  }

  async getEscalationChain(): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT u.id, u.name, u.email, u.slack_id, u.phone, e.level, e.role
       FROM escalation_chain e
       JOIN users u ON u.id = e.user_id
       WHERE e.active = true
       ORDER BY e.level`
    );
    return result.rows;
  }

  async createIncident(params: IncidentParams): Promise<Incident> {
    const id = uuidv4();
    const now = new Date();

    // insert incident record
    await this.pool.query(
      `INSERT INTO incidents (id, message, severity, source, status, escalation_level, created_at)
       VALUES ($1, $2, $3, $4, 'open', 0, $5)`,
      [id, params.message, params.severity, params.source, now.toISOString()]
    );

    this.logger.info('Incident created', { id, severity: params.severity });

    // Get current oncall
    const oncallResult = await this.pool.query(
      `SELECT s.user_id, u.name, u.slack_id, u.phone
       FROM oncall_schedule s
       JOIN users u ON u.id = s.user_id
       WHERE s.start_time <= $1 AND s.end_time > $1
       LIMIT 1`,
      [now.toISOString()]
    );

    if (oncallResult.rows.length > 0) {
      const oncall = oncallResult.rows[0];

      // Notify via Slack
      const severityEmoji = {
        critical: ':rotating_light:',
        high: ':warning:',
        medium: ':information_source:',
        low: ':memo:',
      };

      await this.slack.postMessage(
        `${severityEmoji[params.severity] || ''} *${params.severity.toUpperCase()} Incident* (${id.slice(0, 8)})\n` +
        `${params.message}\n` +
        `Source: ${params.source}\n` +
        `Oncall: <@${oncall.slack_id}>\n` +
        `Acknowledge: \`/oncall ack ${id}\``
      );

      // For critical incidents, also page via PagerDuty
      if (params.severity === 'critical') {
        await this.triggerPagerDuty(id, params.message, oncall);
      }

      // For critical or high, also send SMS
      // TODO: implement SMS via Twilio
      // we have a Twilio account but nobody set up the integration yet
      if (params.severity === 'critical' || params.severity === 'high') {
        this.logger.info('Would send SMS but Twilio not configured', {
          phone: oncall.phone,
        });
      }
    } else {
      this.logger.error('No oncall engineer to notify!');
      // post to the channel anyway so someone sees it
      await this.slack.postMessage(
        `:rotating_light: *INCIDENT with NO ONCALL ENGINEER*\n` +
        `${params.message}\n` +
        `Severity: ${params.severity}\n` +
        `Someone please respond!`
      );
    }

    return {
      id,
      message: params.message,
      severity: params.severity,
      source: params.source,
      status: 'open',
      escalationLevel: 0,
      createdAt: now.toISOString(),
    };
  }

  async acknowledgeIncident(incidentId: string, userId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE incidents
       SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
      [incidentId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Incident not found or already acknowledged');
    }

    const incident = result.rows[0];
    this.logger.info('Incident acknowledged', { incidentId, userId });

    await this.slack.postMessage(
      `:white_check_mark: Incident ${incidentId.slice(0, 8)} acknowledged by <@${userId}>`
    );

    // if it was paged via PagerDuty, ack there too
    if (incident.pagerduty_id) {
      await this.ackPagerDuty(incident.pagerduty_id);
    }
  }

  async resolveIncident(
    incidentId: string,
    userId: string,
    resolution?: string
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE incidents
       SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, resolution = $3
       WHERE id = $1 AND status IN ('open', 'acknowledged')
       RETURNING *`,
      [incidentId, userId, resolution || null]
    );

    if (result.rows.length === 0) {
      throw new Error('Incident not found or already resolved');
    }

    const incident = result.rows[0];
    const duration = incident.resolved_at && incident.created_at
      ? Math.round((new Date(incident.resolved_at).getTime() - new Date(incident.created_at).getTime()) / 60000)
      : 'unknown';

    this.logger.info('Incident resolved', { incidentId, userId, durationMinutes: duration });

    await this.slack.postMessage(
      `:large_green_circle: Incident ${incidentId.slice(0, 8)} resolved by <@${userId}>\n` +
      `Duration: ${duration} minutes\n` +
      (resolution ? `Resolution: ${resolution}` : '')
    );

    // resolve in PagerDuty too
    if (incident.pagerduty_id) {
      await this.resolvePagerDuty(incident.pagerduty_id);
    }
  }

  async checkStaleIncidents(): Promise<Incident[]> {
    // find open incidents that haven't been acknowledged within the timeout
    const result = await this.pool.query(
      `SELECT * FROM incidents
       WHERE status = 'open'
       AND escalated = false
       ORDER BY created_at`
    );

    const stale: Incident[] = [];
    const now = new Date();

    for (const row of result.rows) {
      const created = new Date(row.created_at);
      const ageMinutes = (now.getTime() - created.getTime()) / 60000;
      const timeouts = ESCALATION_TIMEOUTS_MINUTES[row.severity] || [30];
      const currentLevel = row.escalation_level || 0;

      if (currentLevel < timeouts.length && ageMinutes >= timeouts[currentLevel]) {
        stale.push({
          id: row.id,
          message: row.message,
          severity: row.severity,
          source: row.source,
          status: row.status,
          escalationLevel: currentLevel,
          createdAt: row.created_at,
        });
      }
    }

    return stale;
  }

  async escalate(incidentId: string): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const incident = await client.query(
        `SELECT * FROM incidents WHERE id = $1 FOR UPDATE`,
        [incidentId]
      );

      if (incident.rows.length === 0) return;

      const row = incident.rows[0];
      const nextLevel = (row.escalation_level || 0) + 1;

      // get the next person in the escalation chain
      const nextPerson = await client.query(
        `SELECT u.name, u.slack_id, u.phone, e.role
         FROM escalation_chain e
         JOIN users u ON u.id = e.user_id
         WHERE e.level = $1 AND e.active = true`,
        [nextLevel]
      );

      // update escalation level
      await client.query(
        `UPDATE incidents SET escalation_level = $2, escalated = true WHERE id = $1`,
        [incidentId, nextLevel]
      );

      await client.query('COMMIT');

      if (nextPerson.rows.length > 0) {
        const person = nextPerson.rows[0];
        this.logger.warn('Escalating incident', {
          incidentId,
          level: nextLevel,
          to: person.name,
        });

        await this.slack.postMessage(
          `:arrow_up: *Escalation Level ${nextLevel}*\n` +
          `Incident ${incidentId.slice(0, 8)} not acknowledged. Escalating to ${person.name} (${person.role})\n` +
          `<@${person.slack_id}> please respond.`
        );

        // for critical incidents at level 2+, trigger PagerDuty for the escalation contact too
        if (row.severity === 'critical' && nextLevel >= 2) {
          await this.triggerPagerDuty(incidentId, row.message, person);
        }
      } else {
        this.logger.error('No escalation contact at level', { level: nextLevel });
        await this.slack.postMessage(
          `:sos: Incident ${incidentId.slice(0, 8)} has exhausted the escalation chain! ` +
          `No contact at level ${nextLevel}. @here please respond!`
        );
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async triggerPagerDuty(
    incidentId: string,
    message: string,
    person: any
  ): Promise<void> {
    if (!PAGERDUTY_API_KEY) {
      this.logger.warn('PagerDuty not configured, skipping page');
      return;
    }

    try {
      // using fetch instead of the pagerduty npm package because
      // the package is outdated and doesn't support Events API v2
      const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          routing_key: PAGERDUTY_API_KEY,
          event_action: 'trigger',
          dedup_key: incidentId,
          payload: {
            summary: message,
            severity: 'critical',
            source: 'meridian-oncall-pager',
            component: 'oncall-service',
          },
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        // store the PagerDuty incident ID for future ack/resolve
        await this.pool.query(
          `UPDATE incidents SET pagerduty_id = $2 WHERE id = $1`,
          [incidentId, data.dedup_key]
        );
      } else {
        this.logger.error('PagerDuty trigger failed', {
          status: response.status,
          body: await response.text(),
        });
      }
    } catch (err) {
      this.logger.error('PagerDuty API call failed', { error: err });
      // don't throw - PagerDuty being down shouldn't break our alerting
    }
  }

  private async ackPagerDuty(dedupKey: string): Promise<void> {
    if (!PAGERDUTY_API_KEY) return;

    try {
      await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: PAGERDUTY_API_KEY,
          event_action: 'acknowledge',
          dedup_key: dedupKey,
        }),
      });
    } catch (err) {
      this.logger.error('PagerDuty ack failed', { error: err });
    }
  }

  private async resolvePagerDuty(dedupKey: string): Promise<void> {
    if (!PAGERDUTY_API_KEY) return;

    try {
      await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: PAGERDUTY_API_KEY,
          event_action: 'resolve',
          dedup_key: dedupKey,
        }),
      });
    } catch (err) {
      this.logger.error('PagerDuty resolve failed', { error: err });
    }
  }
}
