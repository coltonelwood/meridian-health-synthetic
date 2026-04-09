/**
 * Claims REST API routes.
 *
 * Handles CRUD operations, status checks, and bulk operations for insurance claims.
 * Authentication/authorization is handled by the API gateway (Kong) - by the time
 * requests reach us, the JWT has been validated and user context is in headers.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import Joi from 'joi';
import { ClaimStatus, ClaimType, FilingIndicator, VALID_STATUS_TRANSITIONS, claimFromRow, CreateClaimInput } from '../models/Claim';
import { claimLineFromRow, CreateClaimLineInput } from '../models/ClaimLine';
import { processClaim, validateClaimForSubmission } from '../services/claimProcessor';

export const claimsRouter = Router();

// ---- Validation schemas ----

const createClaimSchema = Joi.object({
  claimType: Joi.string().valid(...Object.values(ClaimType)).required(),
  filingIndicator: Joi.string().valid(...Object.values(FilingIndicator)).default('COMMERCIAL'),
  subscriberId: Joi.string().max(80).required(),
  patient: Joi.object({
    patientId: Joi.string().max(80).required(),
    firstName: Joi.string().max(100),
    lastName: Joi.string().max(100),
    dateOfBirth: Joi.string().isoDate(),
    gender: Joi.string().valid('M', 'F', 'U'),
    addressLine1: Joi.string().max(255),
    addressLine2: Joi.string().max(255),
    city: Joi.string().max(100),
    state: Joi.string().max(2),
    zip: Joi.string().max(10),
    relationshipToSubscriber: Joi.string().max(2).default('18'),
  }).required(),
  provider: Joi.object({
    billingProviderNpi: Joi.string().length(10).pattern(/^[0-9]+$/).required(),
    billingProviderTaxId: Joi.string().max(15),
    billingProviderName: Joi.string().max(255),
    renderingProviderNpi: Joi.string().length(10).pattern(/^[0-9]+$/),
    referringProviderNpi: Joi.string().length(10).pattern(/^[0-9]+$/),
    facilityNpi: Joi.string().length(10).pattern(/^[0-9]+$/),
    placeOfService: Joi.string().max(2).default('11'),
  }).required(),
  payer: Joi.object({
    payerId: Joi.string().max(50).required(),
    payerName: Joi.string().max(255),
    planId: Joi.string().max(80),
    groupNumber: Joi.string().max(50),
    priorAuthNumber: Joi.string().max(50),
  }).required(),
  diagnosisCodes: Joi.array().items(Joi.string().max(10)).min(1).max(12).required(),
  diagnosisCodeType: Joi.string().max(5).default('ABK'),
  serviceDateFrom: Joi.string().isoDate().required(),
  serviceDateTo: Joi.string().isoDate(),
  admissionDate: Joi.string().isoDate(),
  dischargeDate: Joi.string().isoDate(),
  coordinationOfBenefits: Joi.object({
    isSecondaryClaim: Joi.boolean().default(false),
    primaryPayerId: Joi.string().max(50),
    primaryClaimNumber: Joi.string().max(50),
  }),
  lines: Joi.array().items(Joi.object({
    cptCode: Joi.string().max(5).required(),
    modifier1: Joi.string().max(2),
    modifier2: Joi.string().max(2),
    modifier3: Joi.string().max(2),
    modifier4: Joi.string().max(2),
    revenueCode: Joi.string().max(4),
    ndcCode: Joi.string().max(11),
    diagnosisPointer: Joi.array().items(Joi.number().integer().min(1).max(12)),
    placeOfService: Joi.string().max(2),
    serviceDateFrom: Joi.string().isoDate(),
    serviceDateTo: Joi.string().isoDate(),
    units: Joi.number().positive().default(1),
    unitType: Joi.string().max(2).default('UN'),
    chargeAmount: Joi.number().positive().required(),
    renderingProviderNpi: Joi.string().length(10).pattern(/^[0-9]+$/),
  })).min(1).required(),
  metadata: Joi.object().default({}),
});

const updateClaimSchema = Joi.object({
  patient: Joi.object({
    firstName: Joi.string().max(100),
    lastName: Joi.string().max(100),
    dateOfBirth: Joi.string().isoDate(),
    gender: Joi.string().valid('M', 'F', 'U'),
    addressLine1: Joi.string().max(255),
    addressLine2: Joi.string().max(255),
    city: Joi.string().max(100),
    state: Joi.string().max(2),
    zip: Joi.string().max(10),
  }),
  provider: Joi.object({
    renderingProviderNpi: Joi.string().length(10).pattern(/^[0-9]+$/),
    referringProviderNpi: Joi.string().length(10).pattern(/^[0-9]+$/),
    placeOfService: Joi.string().max(2),
  }),
  diagnosisCodes: Joi.array().items(Joi.string().max(10)).min(1).max(12),
  serviceDateFrom: Joi.string().isoDate(),
  serviceDateTo: Joi.string().isoDate(),
  metadata: Joi.object(),
}).min(1);

// ---- Helper to generate claim numbers ----
// Format: CLM-YYYYMMDD-XXXXX (e.g., CLM-20240115-A3F7K)
function generateClaimNumber(): string {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = uuidv4().slice(0, 5).toUpperCase();
  return `CLM-${dateStr}-${rand}`;
}

// ---- Middleware ----

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function getUserId(req: Request): string {
  // The API gateway sets this header after JWT validation
  return (req.headers['x-user-id'] as string) || 'system';
}

// ---- Routes ----

/**
 * GET /api/v1/claims
 * List claims with pagination and filtering.
 */
claimsRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const logger = req.app.locals.logger;

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25));
  const offset = (page - 1) * limit;

  // Build WHERE clause dynamically. Yes I know about SQL injection.
  // We're using parameterized queries below, the string building is just
  // for the WHERE conditions.
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: any[] = [];
  let paramIndex = 1;

  if (req.query.status) {
    const statuses = (req.query.status as string).split(',');
    conditions.push(`status = ANY($${paramIndex}::claim_status[])`);
    params.push(statuses);
    paramIndex++;
  }

  if (req.query.payerId) {
    conditions.push(`payer_id = $${paramIndex}`);
    params.push(req.query.payerId);
    paramIndex++;
  }

  if (req.query.subscriberId) {
    conditions.push(`subscriber_id = $${paramIndex}`);
    params.push(req.query.subscriberId);
    paramIndex++;
  }

  if (req.query.patientId) {
    conditions.push(`patient_id = $${paramIndex}`);
    params.push(req.query.patientId);
    paramIndex++;
  }

  if (req.query.billingProviderNpi) {
    conditions.push(`billing_provider_npi = $${paramIndex}`);
    params.push(req.query.billingProviderNpi);
    paramIndex++;
  }

  if (req.query.claimNumber) {
    conditions.push(`claim_number = $${paramIndex}`);
    params.push(req.query.claimNumber);
    paramIndex++;
  }

  if (req.query.serviceDateFrom) {
    conditions.push(`service_date_from >= $${paramIndex}`);
    params.push(req.query.serviceDateFrom);
    paramIndex++;
  }

  if (req.query.serviceDateTo) {
    conditions.push(`service_date_to <= $${paramIndex}`);
    params.push(req.query.serviceDateTo);
    paramIndex++;
  }

  // Sort - default to created_at desc
  const sortColumn = ['created_at', 'updated_at', 'claim_number', 'total_charge_amount', 'status'].includes(req.query.sort as string)
    ? req.query.sort as string
    : 'created_at';
  const sortDir = (req.query.order as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const whereClause = conditions.join(' AND ');

  try {
    const [claimsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM claims WHERE ${whereClause} ORDER BY ${sortColumn} ${sortDir} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) as total FROM claims WHERE ${whereClause}`,
        params
      ),
    ]);

    const claims = claimsResult.rows.map(claimFromRow);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      data: claims,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    logger.error('Error listing claims', { error: err.message });
    throw err;
  }
}));

/**
 * GET /api/v1/claims/:id
 * Get a single claim by ID, including its line items.
 */
claimsRouter.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;

  const [claimResult, linesResult] = await Promise.all([
    pool.query('SELECT * FROM claims WHERE id = $1 AND deleted_at IS NULL', [req.params.id]),
    pool.query('SELECT * FROM claim_lines WHERE claim_id = $1 ORDER BY line_number', [req.params.id]),
  ]);

  if (claimResult.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }

  const claim = claimFromRow(claimResult.rows[0]);
  const lines = linesResult.rows.map(claimLineFromRow);

  res.json({ data: { ...claim, lines } });
}));

/**
 * POST /api/v1/claims
 * Create a new claim in DRAFT status.
 */
claimsRouter.post('/', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const logger = req.app.locals.logger;

  const { error, value } = createClaimSchema.validate(req.body, { stripUnknown: true });
  if (error) {
    res.status(400).json({ error: 'Validation error', details: error.details });
    return;
  }

  const claimNumber = generateClaimNumber();
  const userId = getUserId(req);
  const { lines, ...claimData } = value;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calculate total charge from lines
    const totalCharge = lines.reduce((sum: number, line: any) => sum + (line.chargeAmount * (line.units || 1)), 0);

    // Insert claim
    const claimResult = await client.query(
      `INSERT INTO claims (
        claim_number, status, claim_type, filing_indicator,
        subscriber_id, patient_id, patient_first_name, patient_last_name,
        patient_dob, patient_gender, patient_address_line1, patient_address_line2,
        patient_city, patient_state, patient_zip, relationship_to_subscriber,
        billing_provider_npi, billing_provider_tax_id, billing_provider_name,
        rendering_provider_npi, referring_provider_npi, facility_npi, place_of_service,
        payer_id, payer_name, plan_id, group_number, prior_auth_number,
        diagnosis_codes, diagnosis_code_type, total_charge_amount,
        service_date_from, service_date_to, admission_date, discharge_date,
        is_secondary_claim, primary_payer_id, primary_claim_number,
        created_by, updated_by, metadata
      ) VALUES (
        $1, 'DRAFT', $2, $3,
        $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21, $22,
        $23, $24, $25, $26, $27,
        $28, $29, $30,
        $31, $32, $33, $34,
        $35, $36, $37,
        $38, $39, $40
      ) RETURNING *`,
      [
        claimNumber, claimData.claimType, claimData.filingIndicator,
        claimData.subscriberId, claimData.patient.patientId,
        claimData.patient.firstName, claimData.patient.lastName,
        claimData.patient.dateOfBirth, claimData.patient.gender,
        claimData.patient.addressLine1, claimData.patient.addressLine2,
        claimData.patient.city, claimData.patient.state,
        claimData.patient.zip, claimData.patient.relationshipToSubscriber,
        claimData.provider.billingProviderNpi, claimData.provider.billingProviderTaxId,
        claimData.provider.billingProviderName,
        claimData.provider.renderingProviderNpi, claimData.provider.referringProviderNpi,
        claimData.provider.facilityNpi, claimData.provider.placeOfService,
        claimData.payer.payerId, claimData.payer.payerName,
        claimData.payer.planId, claimData.payer.groupNumber,
        claimData.payer.priorAuthNumber,
        claimData.diagnosisCodes, claimData.diagnosisCodeType, totalCharge,
        claimData.serviceDateFrom, claimData.serviceDateTo,
        claimData.admissionDate, claimData.dischargeDate,
        claimData.coordinationOfBenefits?.isSecondaryClaim || false,
        claimData.coordinationOfBenefits?.primaryPayerId,
        claimData.coordinationOfBenefits?.primaryClaimNumber,
        userId, userId, claimData.metadata || {},
      ]
    );

    const claimId = claimResult.rows[0].id;

    // Insert claim lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await client.query(
        `INSERT INTO claim_lines (
          claim_id, line_number, cpt_code, modifier_1, modifier_2, modifier_3, modifier_4,
          revenue_code, ndc_code, diagnosis_pointer, place_of_service,
          service_date_from, service_date_to, units, unit_type, charge_amount,
          rendering_provider_npi
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          claimId, i + 1, line.cptCode,
          line.modifier1, line.modifier2, line.modifier3, line.modifier4,
          line.revenueCode, line.ndcCode,
          line.diagnosisPointer || [1],
          line.placeOfService || claimData.provider.placeOfService,
          line.serviceDateFrom || claimData.serviceDateFrom,
          line.serviceDateTo || claimData.serviceDateTo,
          line.units || 1, line.unitType || 'UN', line.chargeAmount,
          line.renderingProviderNpi,
        ]
      );
    }

    // Record status history
    await client.query(
      `INSERT INTO claim_status_history (claim_id, to_status, changed_by, change_reason)
       VALUES ($1, 'DRAFT', $2, 'Claim created')`,
      [claimId, userId]
    );

    await client.query('COMMIT');

    logger.info('Claim created', { claimId, claimNumber, userId, lineCount: lines.length });

    const claim = claimFromRow(claimResult.rows[0]);
    res.status(201).json({ data: { ...claim, totalChargeAmount: totalCharge } });
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error('Error creating claim', { error: err.message, stack: err.stack });
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * PATCH /api/v1/claims/:id
 * Update a claim. Only allowed in DRAFT status.
 */
claimsRouter.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;

  const { error, value } = updateClaimSchema.validate(req.body, { stripUnknown: true });
  if (error) {
    res.status(400).json({ error: 'Validation error', details: error.details });
    return;
  }

  // Check current status
  const existing = await pool.query('SELECT status, version FROM claims WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (existing.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }
  if (existing.rows[0].status !== 'DRAFT') {
    res.status(409).json({ error: 'Claim can only be updated in DRAFT status', currentStatus: existing.rows[0].status });
    return;
  }

  // Build dynamic UPDATE query
  // This is a code smell but building a proper query builder felt like overkill
  const updates: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (value.patient) {
    if (value.patient.firstName !== undefined) { updates.push(`patient_first_name = $${paramIndex++}`); params.push(value.patient.firstName); }
    if (value.patient.lastName !== undefined) { updates.push(`patient_last_name = $${paramIndex++}`); params.push(value.patient.lastName); }
    if (value.patient.dateOfBirth !== undefined) { updates.push(`patient_dob = $${paramIndex++}`); params.push(value.patient.dateOfBirth); }
    if (value.patient.gender !== undefined) { updates.push(`patient_gender = $${paramIndex++}`); params.push(value.patient.gender); }
    if (value.patient.addressLine1 !== undefined) { updates.push(`patient_address_line1 = $${paramIndex++}`); params.push(value.patient.addressLine1); }
    if (value.patient.addressLine2 !== undefined) { updates.push(`patient_address_line2 = $${paramIndex++}`); params.push(value.patient.addressLine2); }
    if (value.patient.city !== undefined) { updates.push(`patient_city = $${paramIndex++}`); params.push(value.patient.city); }
    if (value.patient.state !== undefined) { updates.push(`patient_state = $${paramIndex++}`); params.push(value.patient.state); }
    if (value.patient.zip !== undefined) { updates.push(`patient_zip = $${paramIndex++}`); params.push(value.patient.zip); }
  }

  if (value.provider) {
    if (value.provider.renderingProviderNpi !== undefined) { updates.push(`rendering_provider_npi = $${paramIndex++}`); params.push(value.provider.renderingProviderNpi); }
    if (value.provider.referringProviderNpi !== undefined) { updates.push(`referring_provider_npi = $${paramIndex++}`); params.push(value.provider.referringProviderNpi); }
    if (value.provider.placeOfService !== undefined) { updates.push(`place_of_service = $${paramIndex++}`); params.push(value.provider.placeOfService); }
  }

  if (value.diagnosisCodes) { updates.push(`diagnosis_codes = $${paramIndex++}`); params.push(value.diagnosisCodes); }
  if (value.serviceDateFrom) { updates.push(`service_date_from = $${paramIndex++}`); params.push(value.serviceDateFrom); }
  if (value.serviceDateTo) { updates.push(`service_date_to = $${paramIndex++}`); params.push(value.serviceDateTo); }
  if (value.metadata) { updates.push(`metadata = metadata || $${paramIndex++}`); params.push(JSON.stringify(value.metadata)); }

  updates.push(`updated_by = $${paramIndex++}`);
  params.push(getUserId(req));

  // Optimistic locking
  updates.push(`version = version + 1`);
  params.push(req.params.id);
  params.push(existing.rows[0].version);

  const result = await pool.query(
    `UPDATE claims SET ${updates.join(', ')} WHERE id = $${paramIndex} AND version = $${paramIndex + 1} AND deleted_at IS NULL RETURNING *`,
    params
  );

  if (result.rows.length === 0) {
    res.status(409).json({ error: 'Claim was modified by another user. Please refresh and try again.' });
    return;
  }

  res.json({ data: claimFromRow(result.rows[0]) });
}));

/**
 * DELETE /api/v1/claims/:id
 * Soft delete a claim. Only allowed in DRAFT status.
 */
claimsRouter.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;

  const result = await pool.query(
    `UPDATE claims SET deleted_at = NOW(), updated_by = $1 WHERE id = $2 AND status = 'DRAFT' AND deleted_at IS NULL RETURNING id`,
    [getUserId(req), req.params.id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found or not in DRAFT status' });
    return;
  }

  res.status(204).send();
}));

/**
 * POST /api/v1/claims/:id/submit
 * Submit a claim for processing. Validates and publishes to the submission queue.
 */
claimsRouter.post('/:id/submit', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const logger = req.app.locals.logger;
  const rabbitChannel = req.app.locals.rabbitChannel;

  // Get the claim with lines
  const [claimResult, linesResult] = await Promise.all([
    pool.query('SELECT * FROM claims WHERE id = $1 AND deleted_at IS NULL', [req.params.id]),
    pool.query('SELECT * FROM claim_lines WHERE claim_id = $1 ORDER BY line_number', [req.params.id]),
  ]);

  if (claimResult.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }

  const claim = claimFromRow(claimResult.rows[0]);
  const lines = linesResult.rows.map(claimLineFromRow);

  // Check status
  if (claim.status !== ClaimStatus.DRAFT) {
    res.status(409).json({
      error: 'Claim can only be submitted from DRAFT status',
      currentStatus: claim.status,
    });
    return;
  }

  // Validate
  const validationErrors = validateClaimForSubmission(claim, lines);
  if (validationErrors.length > 0) {
    res.status(422).json({ error: 'Claim validation failed', validationErrors });
    return;
  }

  // Update status
  const userId = getUserId(req);
  await pool.query(
    `UPDATE claims SET status = 'SUBMITTED', updated_by = $1, version = version + 1 WHERE id = $2`,
    [userId, claim.id]
  );
  await pool.query(
    `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason)
     VALUES ($1, $2, 'SUBMITTED', $3, 'Claim submitted for processing')`,
    [claim.id, claim.status, userId]
  );

  // Publish to RabbitMQ for async processing
  if (rabbitChannel) {
    const message = {
      claimId: claim.id,
      claimNumber: claim.claimNumber,
      payerId: claim.payer.payerId,
      submittedBy: userId,
      submittedAt: new Date().toISOString(),
    };

    rabbitChannel.sendToQueue(
      req.app.locals.queues.CLAIM_SUBMISSION,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        messageId: uuidv4(),
        timestamp: Date.now(),
        headers: { 'x-retry-count': 0 },
      }
    );

    logger.info('Claim submitted to processing queue', { claimId: claim.id, claimNumber: claim.claimNumber });
  } else {
    // RabbitMQ not available - process synchronously (slower but works)
    // This shouldn't happen in production but does in dev sometimes
    logger.warn('RabbitMQ not available, processing claim synchronously', { claimId: claim.id });
    try {
      await processClaim(claim.id, pool, req.app.locals.redis, logger);
    } catch (err: any) {
      logger.error('Synchronous claim processing failed', { claimId: claim.id, error: err.message });
      // Don't fail the request - the claim is already SUBMITTED
      // Someone will need to retry manually
    }
  }

  res.json({
    data: { ...claim, status: ClaimStatus.SUBMITTED },
    message: 'Claim submitted for processing',
  });
}));

/**
 * POST /api/v1/claims/:id/void
 * Void a claim. Allowed from most statuses.
 */
claimsRouter.post('/:id/void', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const logger = req.app.locals.logger;
  const userId = getUserId(req);

  const reason = req.body.reason || 'No reason provided';

  const claimResult = await pool.query('SELECT * FROM claims WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (claimResult.rows.length === 0) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }

  const claim = claimFromRow(claimResult.rows[0]);
  const validTransitions = VALID_STATUS_TRANSITIONS[claim.status];

  if (!validTransitions.includes(ClaimStatus.VOID)) {
    res.status(409).json({
      error: `Cannot void claim in ${claim.status} status`,
      currentStatus: claim.status,
    });
    return;
  }

  await pool.query(
    `UPDATE claims SET status = 'VOID', updated_by = $1, version = version + 1 WHERE id = $2`,
    [userId, claim.id]
  );
  await pool.query(
    `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason)
     VALUES ($1, $2, 'VOID', $3, $4)`,
    [claim.id, claim.status, userId, reason]
  );

  logger.info('Claim voided', { claimId: claim.id, claimNumber: claim.claimNumber, reason, userId });

  res.json({ data: { ...claim, status: ClaimStatus.VOID }, message: 'Claim voided' });
}));

/**
 * GET /api/v1/claims/:id/history
 * Get status change history for a claim.
 */
claimsRouter.get('/:id/history', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;

  const result = await pool.query(
    `SELECT * FROM claim_status_history WHERE claim_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );

  res.json({ data: result.rows });
}));

/**
 * POST /api/v1/claims/bulk/submit
 * Bulk submit multiple claims. Used by the batch processing UI.
 *
 * NOTE: This endpoint is intentionally not transactional - if one claim
 * fails validation, the others still get submitted. The response includes
 * per-claim results. This is by design because billing staff don't want
 * one bad claim to block an entire batch.
 */
claimsRouter.post('/bulk/submit', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const logger = req.app.locals.logger;
  const rabbitChannel = req.app.locals.rabbitChannel;
  const userId = getUserId(req);

  const { claimIds } = req.body;
  if (!Array.isArray(claimIds) || claimIds.length === 0) {
    res.status(400).json({ error: 'claimIds array is required' });
    return;
  }

  if (claimIds.length > 500) {
    res.status(400).json({ error: 'Maximum 500 claims per bulk submission' });
    return;
  }

  const results: Array<{ claimId: string; status: string; error?: string }> = [];

  // Process each claim individually
  // TODO: this should be parallelized but we need to be careful about
  // DB connection pool exhaustion. For now, sequential is safer.
  for (const claimId of claimIds) {
    try {
      const [claimResult, linesResult] = await Promise.all([
        pool.query('SELECT * FROM claims WHERE id = $1 AND deleted_at IS NULL', [claimId]),
        pool.query('SELECT * FROM claim_lines WHERE claim_id = $1', [claimId]),
      ]);

      if (claimResult.rows.length === 0) {
        results.push({ claimId, status: 'error', error: 'Claim not found' });
        continue;
      }

      const claim = claimFromRow(claimResult.rows[0]);
      if (claim.status !== ClaimStatus.DRAFT) {
        results.push({ claimId, status: 'skipped', error: `Claim is in ${claim.status} status, not DRAFT` });
        continue;
      }

      const lines = linesResult.rows.map(claimLineFromRow);
      const validationErrors = validateClaimForSubmission(claim, lines);
      if (validationErrors.length > 0) {
        results.push({ claimId, status: 'error', error: validationErrors.join('; ') });
        continue;
      }

      await pool.query(
        `UPDATE claims SET status = 'SUBMITTED', updated_by = $1, version = version + 1 WHERE id = $2`,
        [userId, claimId]
      );

      if (rabbitChannel) {
        rabbitChannel.sendToQueue(
          req.app.locals.queues.CLAIM_SUBMISSION,
          Buffer.from(JSON.stringify({ claimId, submittedBy: userId, submittedAt: new Date().toISOString() })),
          { persistent: true, messageId: uuidv4() }
        );
      }

      results.push({ claimId, status: 'submitted' });
    } catch (err: any) {
      logger.error('Error in bulk submit for claim', { claimId, error: err.message });
      results.push({ claimId, status: 'error', error: err.message });
    }
  }

  const submitted = results.filter((r) => r.status === 'submitted').length;
  const failed = results.filter((r) => r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  logger.info('Bulk claim submission completed', { submitted, failed, skipped, total: claimIds.length });

  res.json({
    data: results,
    summary: { submitted, failed, skipped, total: claimIds.length },
  });
}));

/**
 * GET /api/v1/claims/stats
 * Get claim statistics. Used by the dashboard.
 */
claimsRouter.get('/stats/summary', asyncHandler(async (req: Request, res: Response) => {
  const pool: Pool = req.app.locals.pool;
  const redis = req.app.locals.redis;

  // Try cache first - these stats are expensive to compute
  const cacheKey = 'stats:summary';
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json({ data: JSON.parse(cached), cached: true });
      return;
    }
  } catch {
    // Redis error - just compute from DB
  }

  const result = await pool.query(`
    SELECT
      status,
      COUNT(*) as count,
      COALESCE(SUM(total_charge_amount), 0) as total_charges,
      COALESCE(SUM(total_paid_amount), 0) as total_paid
    FROM claims
    WHERE deleted_at IS NULL
    GROUP BY status
    ORDER BY status
  `);

  const stats = result.rows.reduce((acc: any, row: any) => {
    acc[row.status] = {
      count: parseInt(row.count),
      totalCharges: parseFloat(row.total_charges),
      totalPaid: parseFloat(row.total_paid),
    };
    return acc;
  }, {});

  // Cache for 5 minutes
  try {
    await redis.setex(cacheKey, 300, JSON.stringify(stats));
  } catch {
    // Redis write failed - not critical
  }

  res.json({ data: stats, cached: false });
}));
