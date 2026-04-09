/**
 * Adjudication API routes.
 *
 * These endpoints handle the adjudication process - determining how much
 * to pay on a claim based on payer rules, fee schedules, and benefits.
 *
 * Most adjudication happens automatically via the adjudication engine,
 * but some claims require manual review (flagged by the rules engine).
 * This API supports both workflows.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { ClaimStatus, VALID_STATUS_TRANSITIONS, claimFromRow } from '../models/Claim';
import { claimLineFromRow } from '../models/ClaimLine';
import { runAdjudication, AdjudicationResult } from '../services/adjudicationEngine';
import { getPayerConfig } from '../utils/payerRules';

export const adjudicationRouter = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function getUserId(req: Request): string {
  return (req.headers['x-user-id'] as string) || 'system';
}

/**
 * POST /api/v1/adjudication/:claimId/run
 * Run auto-adjudication on a claim.
 *
 * This is normally triggered by the claim submission worker, but can also
 * be called manually by adjudication staff via the admin UI.
 *
 * // TODO: Add rate limiting - we had an incident where someone ran this
 * // endpoint in a tight loop for 2000 claims and it overwhelmed the
 * // fee schedule lookup service. We need rate-limit middleware here.
 * // Ticket: CLAIMS-901
 */
adjudicationRouter.post('/:claimId/run', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const redis = req.app.locals.redis;
  const logger = req.app.locals.logger;
  const userId = getUserId(req);

  const { claimId } = req.params;

  // Fetch claim and lines
  const [claimResult, linesResult] = await Promise.all([
    pool.query('SELECT * FROM claims WHERE id = $1 AND deleted_at IS NULL', [claimId]),
    pool.query('SELECT * FROM claim_lines WHERE claim_id = $1 ORDER BY line_number', [claimId]),
  ]);

  if (claimResult.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }

  const claim = claimFromRow(claimResult.rows[0]);
  const lines = linesResult.rows.map(claimLineFromRow);

  // Must be SUBMITTED or PENDING_REVIEW to adjudicate
  if (claim.status !== ClaimStatus.SUBMITTED && claim.status !== ClaimStatus.PENDING_REVIEW) {
    res.status(409).json({
      error: `Cannot adjudicate claim in ${claim.status} status`,
      allowedStatuses: ['SUBMITTED', 'PENDING_REVIEW'],
    });
    return;
  }

  // Check if payer supports auto-adjudication
  const payerConfig = getPayerConfig(claim.payer.payerId);
  if (payerConfig && !payerConfig.autoAdjudicateEligible) {
    // Route to manual review instead
    await pool.query(
      `UPDATE claims SET status = 'PENDING_REVIEW', updated_by = $1, version = version + 1 WHERE id = $2`,
      [userId, claimId]
    );
    await pool.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason)
       VALUES ($1, $2, 'PENDING_REVIEW', $3, 'Payer does not support auto-adjudication')`,
      [claimId, claim.status, userId]
    );

    res.json({
      data: { claimId, status: 'PENDING_REVIEW', requiresManualReview: true },
      message: `${payerConfig.payerName} claims require manual adjudication`,
    });
    return;
  }

  try {
    // Run the adjudication engine
    const result = await runAdjudication(claim, lines, pool, redis, logger);

    // Update claim based on result
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (result.approved) {
        // Adjudicated - update amounts
        await client.query(
          `UPDATE claims SET
            status = 'ADJUDICATED',
            total_paid_amount = $1,
            patient_responsibility = $2,
            adjudicated_date = NOW(),
            updated_by = $3,
            version = version + 1,
            metadata = metadata || $4
          WHERE id = $5`,
          [
            result.totalPaidAmount,
            result.patientResponsibility,
            userId,
            JSON.stringify({ adjudicationDetails: result.details }),
            claimId,
          ]
        );

        // Update each claim line with adjudication results
        for (const lineResult of result.lineResults) {
          await client.query(
            `UPDATE claim_lines SET
              allowed_amount = $1,
              paid_amount = $2,
              adjustment_amount = $3,
              copay_amount = $4,
              coinsurance_amount = $5,
              deductible_amount = $6,
              adjudication_status = $7,
              remark_codes = $8,
              adjustment_reason_codes = $9
            WHERE id = $10`,
            [
              lineResult.allowedAmount,
              lineResult.paidAmount,
              lineResult.adjustmentAmount,
              lineResult.copayAmount,
              lineResult.coinsuranceAmount,
              lineResult.deductibleAmount,
              lineResult.status,
              lineResult.remarkCodes || [],
              lineResult.adjustmentReasonCodes || [],
              lineResult.lineId,
            ]
          );
        }

        await client.query(
          `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason, metadata)
           VALUES ($1, $2, 'ADJUDICATED', $3, 'Auto-adjudication completed', $4)`,
          [claimId, claim.status, userId, JSON.stringify(result.details)]
        );
      } else {
        // Denied
        await client.query(
          `UPDATE claims SET
            status = 'DENIED',
            denial_reason_code = $1,
            denial_reason_description = $2,
            denial_date = NOW(),
            appeal_deadline = NOW() + INTERVAL '${payerConfig?.appealTimelyFilingDays || 180} days',
            updated_by = $3,
            version = version + 1
          WHERE id = $4`,
          [result.denialReasonCode, result.denialReasonDescription, userId, claimId]
        );

        await client.query(
          `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason, metadata)
           VALUES ($1, $2, 'DENIED', $3, $4, $5)`,
          [claimId, claim.status, userId, result.denialReasonDescription, JSON.stringify(result.details)]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    logger.info('Adjudication completed', {
      claimId,
      approved: result.approved,
      totalPaid: result.totalPaidAmount,
      denialCode: result.denialReasonCode,
    });

    res.json({
      data: {
        claimId,
        approved: result.approved,
        status: result.approved ? 'ADJUDICATED' : 'DENIED',
        totalPaidAmount: result.totalPaidAmount,
        patientResponsibility: result.patientResponsibility,
        denialReasonCode: result.denialReasonCode,
        denialReasonDescription: result.denialReasonDescription,
        lineResults: result.lineResults,
        details: result.details,
      },
    });
  } catch (err: any) {
    logger.error('Adjudication failed', { claimId, error: err.message, stack: err.stack });
    throw err;
  }
}));

/**
 * POST /api/v1/adjudication/:claimId/manual
 * Manually adjudicate a claim. Used by adjudication staff for claims
 * that can't be auto-adjudicated.
 *
 * // TODO: rate limiting - same as above
 * // Also TODO: this endpoint should require a special role/permission
 * // but right now any authenticated user can call it. Security review
 * // flagged this in Q3 2024 audit. Ticket: SEC-445
 */
adjudicationRouter.post('/:claimId/manual', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const logger = req.app.locals.logger;
  const userId = getUserId(req);
  const { claimId } = req.params;

  const {
    approved,
    lineAdjudications,
    denialReasonCode,
    denialReasonDescription,
    notes,
  } = req.body;

  if (typeof approved !== 'boolean') {
    res.status(400).json({ error: 'approved (boolean) is required' });
    return;
  }

  // Fetch claim
  const claimResult = await pool.query('SELECT * FROM claims WHERE id = $1 AND deleted_at IS NULL', [claimId]);
  if (claimResult.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }

  const claim = claimFromRow(claimResult.rows[0]);
  if (claim.status !== ClaimStatus.PENDING_REVIEW && claim.status !== ClaimStatus.SUBMITTED) {
    res.status(409).json({
      error: `Cannot manually adjudicate claim in ${claim.status} status`,
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (approved) {
      if (!lineAdjudications || !Array.isArray(lineAdjudications)) {
        res.status(400).json({ error: 'lineAdjudications array is required when approving' });
        return;
      }

      let totalPaid = 0;
      let totalPatientResp = 0;

      for (const la of lineAdjudications) {
        await client.query(
          `UPDATE claim_lines SET
            allowed_amount = $1,
            paid_amount = $2,
            adjustment_amount = $3,
            copay_amount = $4,
            coinsurance_amount = $5,
            deductible_amount = $6,
            adjudication_status = 'ADJUDICATED',
            remark_codes = $7,
            adjustment_reason_codes = $8
          WHERE id = $9 AND claim_id = $10`,
          [
            la.allowedAmount,
            la.paidAmount,
            la.adjustmentAmount || 0,
            la.copayAmount || 0,
            la.coinsuranceAmount || 0,
            la.deductibleAmount || 0,
            la.remarkCodes || [],
            la.adjustmentReasonCodes || [],
            la.lineId,
            claimId,
          ]
        );
        totalPaid += la.paidAmount || 0;
        totalPatientResp += (la.copayAmount || 0) + (la.coinsuranceAmount || 0) + (la.deductibleAmount || 0);
      }

      await client.query(
        `UPDATE claims SET
          status = 'ADJUDICATED',
          total_paid_amount = $1,
          patient_responsibility = $2,
          adjudicated_date = NOW(),
          updated_by = $3,
          version = version + 1
        WHERE id = $4`,
        [totalPaid, totalPatientResp, userId, claimId]
      );

      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason, metadata)
         VALUES ($1, $2, 'ADJUDICATED', $3, $4, $5)`,
        [claimId, claim.status, userId, notes || 'Manual adjudication - approved', JSON.stringify({ lineAdjudications })]
      );
    } else {
      if (!denialReasonCode) {
        res.status(400).json({ error: 'denialReasonCode is required when denying' });
        return;
      }

      const payerConfig = getPayerConfig(claim.payer.payerId);
      const appealDays = payerConfig?.appealTimelyFilingDays || 180;

      await client.query(
        `UPDATE claims SET
          status = 'DENIED',
          denial_reason_code = $1,
          denial_reason_description = $2,
          denial_date = NOW(),
          appeal_deadline = NOW() + INTERVAL '${appealDays} days',
          updated_by = $3,
          version = version + 1
        WHERE id = $4`,
        [denialReasonCode, denialReasonDescription || '', userId, claimId]
      );

      await client.query(
        `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason, metadata)
         VALUES ($1, $2, 'DENIED', $3, $4, $5)`,
        [claimId, claim.status, userId, notes || `Manual denial: ${denialReasonCode}`, JSON.stringify({ denialReasonCode, denialReasonDescription })]
      );
    }

    await client.query('COMMIT');

    logger.info('Manual adjudication completed', {
      claimId,
      approved,
      userId,
      denialCode: denialReasonCode,
    });

    res.json({
      data: {
        claimId,
        status: approved ? 'ADJUDICATED' : 'DENIED',
        approved,
      },
      message: `Claim ${approved ? 'approved' : 'denied'} via manual adjudication`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * GET /api/v1/adjudication/queue
 * Get claims pending manual adjudication review.
 *
 * // TODO: add rate limiting to prevent polling abuse
 * // The billing team's custom script hits this every 5 seconds
 * // and it's like 15% of our total request volume. We've asked
 * // them to use webhooks but they "don't have time to implement that."
 */
adjudicationRouter.get('/queue', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 25);
  const offset = (page - 1) * limit;

  const payerFilter = req.query.payerId ? 'AND payer_id = $3' : '';
  const params: any[] = [limit, offset];
  if (req.query.payerId) params.push(req.query.payerId);

  const [claimsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM claims
       WHERE status = 'PENDING_REVIEW' AND deleted_at IS NULL ${payerFilter}
       ORDER BY received_date ASC
       LIMIT $1 OFFSET $2`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) as total FROM claims
       WHERE status = 'PENDING_REVIEW' AND deleted_at IS NULL ${payerFilter}`,
      req.query.payerId ? [req.query.payerId] : []
    ),
  ]);

  const claims = claimsResult.rows.map(claimFromRow);
  const total = parseInt(countResult.rows[0].total);

  res.json({
    data: claims,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}));

/**
 * GET /api/v1/adjudication/stats
 * Adjudication statistics - approval rate, average processing time, etc.
 */
adjudicationRouter.get('/stats', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const redis = req.app.locals.redis;

  // Check cache
  try {
    const cached = await redis.get('adjudication:stats');
    if (cached) {
      res.json({ data: JSON.parse(cached), cached: true });
      return;
    }
  } catch { /* ignore redis errors */ }

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('ADJUDICATED', 'PAID')) as approved_count,
      COUNT(*) FILTER (WHERE status = 'DENIED') as denied_count,
      COUNT(*) FILTER (WHERE status = 'PENDING_REVIEW') as pending_count,
      COUNT(*) FILTER (WHERE status = 'APPEALED') as appealed_count,
      COALESCE(AVG(EXTRACT(EPOCH FROM (adjudicated_date - received_date)) / 3600) FILTER (WHERE adjudicated_date IS NOT NULL), 0) as avg_adjudication_hours,
      COALESCE(SUM(total_paid_amount) FILTER (WHERE status IN ('ADJUDICATED', 'PAID')), 0) as total_paid,
      COALESCE(SUM(total_charge_amount) FILTER (WHERE status = 'DENIED'), 0) as total_denied_charges
    FROM claims
    WHERE deleted_at IS NULL
      AND created_at >= NOW() - INTERVAL '30 days'
  `);

  const row = result.rows[0];
  const totalDecided = parseInt(row.approved_count) + parseInt(row.denied_count);
  const stats = {
    approvedCount: parseInt(row.approved_count),
    deniedCount: parseInt(row.denied_count),
    pendingCount: parseInt(row.pending_count),
    appealedCount: parseInt(row.appealed_count),
    approvalRate: totalDecided > 0 ? (parseInt(row.approved_count) / totalDecided * 100).toFixed(1) : 0,
    avgAdjudicationHours: parseFloat(parseFloat(row.avg_adjudication_hours).toFixed(1)),
    totalPaid: parseFloat(row.total_paid),
    totalDeniedCharges: parseFloat(row.total_denied_charges),
    period: 'last_30_days',
  };

  // Cache for 10 minutes
  try {
    await redis.setex('adjudication:stats', 600, JSON.stringify(stats));
  } catch { /* ignore */ }

  res.json({ data: stats, cached: false });
}));
