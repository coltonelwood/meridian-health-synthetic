import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { RotationService } from '../services/rotationService';
import { EscalationService } from '../services/escalationService';
import { SlackNotifier } from '../services/slackNotifier';

export function oncallRouter(
  pool: Pool,
  rotationService: RotationService,
  escalationService: EscalationService,
  slackNotifier: SlackNotifier
): Router {
  const router = Router();

  /**
   * GET /api/oncall/current
   * Who's currently on call?
   */
  router.get('/current', async (_req: Request, res: Response) => {
    try {
      const oncall = await rotationService.getCurrentOncall();
      if (!oncall) {
        // this is bad - nobody is on call
        res.status(200).json({
          oncall: null,
          warning: 'No one is currently assigned as oncall!',
        });
        return;
      }
      res.json({ oncall });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/oncall/schedule
   * Get the oncall schedule for the next N weeks
   */
  router.get('/schedule', async (req: Request, res: Response) => {
    const weeks = parseInt(req.query.weeks as string) || 4;
    try {
      const schedule = await rotationService.getSchedule(weeks);
      res.json({ schedule });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/oncall/swap
   * Request a shift swap between two engineers
   */
  router.post('/swap', async (req: Request, res: Response) => {
    const { fromUserId, toUserId, weekOf, reason } = req.body;

    if (!fromUserId || !toUserId || !weekOf) {
      res.status(400).json({ error: 'fromUserId, toUserId, and weekOf are required' });
      return;
    }

    try {
      const swap = await rotationService.requestSwap(fromUserId, toUserId, weekOf, reason);

      // notify both parties on Slack
      await slackNotifier.postMessage(
        `Oncall swap requested: <@${fromUserId}> wants to swap with <@${toUserId}> ` +
        `for the week of ${weekOf}. Reason: ${reason || 'Not specified'}\n` +
        `<@${toUserId}> please confirm with \`/oncall accept-swap ${swap.id}\``
      );

      res.json({ swap });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /api/oncall/swap/:id/accept
   * Accept a swap request
   */
  router.post('/swap/:id/accept', async (req: Request, res: Response) => {
    try {
      const result = await rotationService.acceptSwap(req.params.id);
      await slackNotifier.postMessage(
        `Swap ${req.params.id} accepted! Schedule updated.`
      );
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /api/oncall/swap/:id/reject
   * Reject a swap request
   */
  router.post('/swap/:id/reject', async (req: Request, res: Response) => {
    try {
      await rotationService.rejectSwap(req.params.id);
      res.json({ status: 'rejected' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * GET /api/oncall/escalation
   * Get the current escalation chain
   */
  router.get('/escalation', async (_req: Request, res: Response) => {
    try {
      const chain = await escalationService.getEscalationChain();
      res.json({ chain });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/oncall/page
   * Page the oncall engineer
   */
  router.post('/page', async (req: Request, res: Response) => {
    const { message, severity, source } = req.body;

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const sev = severity || 'medium'; // default to medium if not specified
    // TODO: validate severity is one of: critical, high, medium, low

    try {
      const incident = await escalationService.createIncident({
        message,
        severity: sev,
        source: source || 'manual',
      });

      res.json({ incident });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/oncall/incidents/:id/acknowledge
   * Acknowledge an incident
   */
  router.post('/incidents/:id/acknowledge', async (req: Request, res: Response) => {
    try {
      await escalationService.acknowledgeIncident(req.params.id, req.body.userId);
      res.json({ status: 'acknowledged' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /api/oncall/incidents/:id/resolve
   * Resolve an incident
   */
  router.post('/incidents/:id/resolve', async (req: Request, res: Response) => {
    try {
      await escalationService.resolveIncident(req.params.id, req.body.userId, req.body.resolution);
      res.json({ status: 'resolved' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * GET /api/oncall/incidents
   * List recent incidents
   */
  router.get('/incidents', async (req: Request, res: Response) => {
    const status = req.query.status as string; // 'open', 'acknowledged', 'resolved'
    const limit = parseInt(req.query.limit as string) || 20;

    try {
      const result = await pool.query(
        `SELECT * FROM incidents
         ${status ? 'WHERE status = $1' : ''}
         ORDER BY created_at DESC
         LIMIT ${status ? '$2' : '$1'}`,
        status ? [status, limit] : [limit]
      );
      res.json({ incidents: result.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/oncall/stats
   * Oncall stats for reporting
   */
  router.get('/stats', async (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 30;

    try {
      // TODO: this query is slow when days > 90, needs an index on created_at
      const result = await pool.query(
        `SELECT
          COUNT(*) as total_incidents,
          COUNT(*) FILTER (WHERE severity = 'critical') as critical,
          COUNT(*) FILTER (WHERE severity = 'high') as high,
          AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at))) as avg_ack_time_seconds,
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) as avg_resolve_time_seconds,
          COUNT(*) FILTER (WHERE escalated = true) as escalated_count
        FROM incidents
        WHERE created_at > NOW() - INTERVAL '${days} days'`
        // NOTE: yes this is string interpolation in SQL. It's an integer and
        // we parseInt'd it above so it's fine. But should really use $1.
        // Added to the "tech debt" list that nobody looks at.
      );

      res.json({ stats: result.rows[0] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
