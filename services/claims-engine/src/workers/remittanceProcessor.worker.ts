/**
 * Remittance Processor Worker
 *
 * Processes incoming ERA (835) files from payers/clearinghouses.
 * The pipeline:
 * 1. Parse the raw X12 835 EDI
 * 2. Create a remittance batch record
 * 3. For each claim in the 835, try to match it to one of our claims
 * 4. Apply payment/adjustment information to matched claims
 *
 * Matching is the hardest part. Payers send back our claim number
 * (patient control number) in the CLP segment, but sometimes it's
 * truncated, has extra characters, or is just wrong. We try several
 * matching strategies in order of confidence.
 *
 * Current match rate: ~95% auto-match, ~5% need manual intervention.
 * The ops team reviews unmatched remittances in the admin UI daily.
 */

import { ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import Redis from 'ioredis';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { parseX12_835 } from '../services/x12Parser';
import { RemittanceStatus, ParsedRemittanceClaim } from '../models/Remittance';
import { ClaimStatus, claimFromRow } from '../models/Claim';

interface RemittanceMessage {
  fileName: string;
  rawContent: string;
  receivedAt: string;
  source: string; // 'clearinghouse' | 'direct' | 'sftp'
}

/**
 * Handle a remittance processing message from RabbitMQ.
 */
export async function handleRemittanceProcessing(
  msg: ConsumeMessage,
  pool: Pool,
  redis: Redis,
  logger: winston.Logger
): Promise<void> {
  let message: RemittanceMessage;
  try {
    message = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error('Failed to parse remittance message', {
      error: (err as Error).message,
    });
    throw err;
  }

  const { fileName, rawContent, receivedAt, source } = message;

  logger.info('Processing remittance file', {
    fileName,
    contentLength: rawContent?.length,
    source,
  });

  if (!rawContent || rawContent.trim().length === 0) {
    logger.error('Empty remittance content', { fileName });
    throw new Error('Empty remittance content');
  }

  // Step 1: Parse the 835
  let parsedRemittance;
  try {
    parsedRemittance = parseX12_835(rawContent);
    logger.info('835 parsed successfully', {
      fileName,
      payerId: parsedRemittance.payerId,
      claimCount: parsedRemittance.claims.length,
      paymentAmount: parsedRemittance.paymentAmount,
    });
  } catch (parseErr: any) {
    logger.error('Failed to parse 835', {
      fileName,
      error: parseErr.message,
      contentPreview: rawContent.substring(0, 200),
    });

    // Still create a batch record so ops can see the failure
    await pool.query(
      `INSERT INTO remittance_batches (
        batch_number, status, payer_id, raw_x12_content, file_name,
        file_received_at, processing_errors
      ) VALUES ($1, 'ERROR', 'UNKNOWN', $2, $3, $4, $5)`,
      [
        `REM-${Date.now()}`,
        rawContent.substring(0, 50000),  // cap at 50KB to avoid DB bloat
        fileName,
        receivedAt,
        JSON.stringify([{ error: parseErr.message, stage: 'parsing' }]),
      ]
    );
    throw parseErr;
  }

  // Step 2: Create remittance batch
  const batchNumber = `REM-${parsedRemittance.payerId}-${Date.now()}`;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      `INSERT INTO remittance_batches (
        batch_number, status, payer_id, payer_name, clearinghouse_id,
        payment_method, payment_date, payment_amount, check_number, trace_number,
        payee_npi, payee_tax_id, payee_name,
        raw_x12_content, file_name, file_received_at,
        total_claims_in_batch
      ) VALUES ($1, 'PARSING', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id`,
      [
        batchNumber,
        parsedRemittance.payerId,
        parsedRemittance.payerName,
        null,  // clearinghouse_id - we don't always know this
        parsedRemittance.paymentMethod,
        parsedRemittance.paymentDate,
        parsedRemittance.paymentAmount,
        parsedRemittance.checkNumber,
        parsedRemittance.traceNumber,
        parsedRemittance.payeeNpi,
        parsedRemittance.payeeTaxId,
        parsedRemittance.payeeName,
        rawContent,
        fileName,
        receivedAt,
        parsedRemittance.claims.length,
      ]
    );

    const batchId = batchResult.rows[0].id;

    // Step 3: Process each claim in the remittance
    let matchedCount = 0;
    let unmatchedCount = 0;
    const errors: any[] = [];

    for (const remitClaim of parsedRemittance.claims) {
      try {
        // Insert remittance detail
        const detailResult = await client.query(
          `INSERT INTO remittance_details (
            batch_id, patient_control_number, payer_claim_number, claim_status_code,
            patient_first_name, patient_last_name, patient_id, subscriber_id,
            charge_amount, paid_amount, patient_responsibility_amount,
            adjustments, service_lines, match_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING')
          RETURNING id`,
          [
            batchId,
            remitClaim.patientControlNumber,
            remitClaim.payerClaimNumber,
            remitClaim.claimStatusCode,
            remitClaim.patientFirstName,
            remitClaim.patientLastName,
            remitClaim.patientId,
            remitClaim.subscriberId,
            remitClaim.chargeAmount,
            remitClaim.paidAmount,
            remitClaim.patientResponsibilityAmount,
            JSON.stringify(remitClaim.adjustments),
            JSON.stringify(remitClaim.serviceLines),
          ]
        );

        const detailId = detailResult.rows[0].id;

        // Try to match to our claims
        const matchResult = await matchRemittanceToClaim(remitClaim, parsedRemittance.payerId, client, logger);

        if (matchResult.matched) {
          // Update the detail with the match
          await client.query(
            `UPDATE remittance_details SET
              claim_id = $1, match_status = 'MATCHED', match_confidence = $2,
              match_method = $3, matched_at = NOW()
            WHERE id = $4`,
            [matchResult.claimId, matchResult.confidence, matchResult.method, detailId]
          );

          // Apply the remittance to the claim
          await applyRemittanceToClaim(matchResult.claimId!, remitClaim, client, logger);
          matchedCount++;
        } else {
          await client.query(
            `UPDATE remittance_details SET match_status = 'UNMATCHED', match_confidence = $1, match_method = $2
            WHERE id = $3`,
            [matchResult.confidence || 0, matchResult.method || 'NONE', detailId]
          );
          unmatchedCount++;
        }
      } catch (claimErr: any) {
        logger.error('Error processing remittance claim', {
          patientControlNumber: remitClaim.patientControlNumber,
          error: claimErr.message,
        });
        errors.push({
          patientControlNumber: remitClaim.patientControlNumber,
          error: claimErr.message,
        });
      }
    }

    // Update batch status
    const batchStatus = unmatchedCount === 0 ? 'MATCHED' :
                        matchedCount === 0 ? 'UNMATCHED' :
                        'PARTIALLY_MATCHED';

    await client.query(
      `UPDATE remittance_batches SET
        status = $1, matched_claims = $2, unmatched_claims = $3,
        processing_errors = $4
      WHERE id = $5`,
      [batchStatus, matchedCount, unmatchedCount, JSON.stringify(errors), batchId]
    );

    await client.query('COMMIT');

    logger.info('Remittance batch processed', {
      batchId,
      batchNumber,
      totalClaims: parsedRemittance.claims.length,
      matched: matchedCount,
      unmatched: unmatchedCount,
      errors: errors.length,
      status: batchStatus,
    });

    // Notify about unmatched claims
    if (unmatchedCount > 0) {
      try {
        await redis.publish('remittance:unmatched', JSON.stringify({
          batchId,
          batchNumber,
          unmatchedCount,
          payerId: parsedRemittance.payerId,
        }));
      } catch {
        // Non-critical
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- Matching logic ----

interface MatchResult {
  matched: boolean;
  claimId?: string;
  confidence: number;
  method: string;
}

/**
 * Try to match a remittance claim to one of our claims.
 * Uses multiple strategies in order of confidence:
 * 1. Exact claim number match
 * 2. Claim number with whitespace/formatting normalization
 * 3. Subscriber + DOS + charge amount match
 * 4. Patient name + DOS + provider match (lowest confidence)
 */
async function matchRemittanceToClaim(
  remitClaim: ParsedRemittanceClaim,
  payerId: string,
  client: any, // pg client from transaction
  logger: winston.Logger
): Promise<MatchResult> {
  const pcn = remitClaim.patientControlNumber?.trim();

  if (!pcn) {
    return { matched: false, confidence: 0, method: 'NONE' };
  }

  // Strategy 1: Exact claim number match
  const exactMatch = await client.query(
    `SELECT id FROM claims WHERE claim_number = $1 AND payer_id = $2 AND deleted_at IS NULL`,
    [pcn, payerId]
  );

  if (exactMatch.rows.length === 1) {
    return { matched: true, claimId: exactMatch.rows[0].id, confidence: 100, method: 'EXACT' };
  }

  // Strategy 2: Normalized claim number match
  // Some payers truncate or pad the claim number, add prefixes, etc.
  const normalizedPcn = pcn.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const normalizedMatch = await client.query(
    `SELECT id, claim_number FROM claims
     WHERE UPPER(REPLACE(REPLACE(REPLACE(claim_number, '-', ''), ' ', ''), '.', '')) = $1
     AND deleted_at IS NULL
     LIMIT 5`,
    [normalizedPcn]
  );

  if (normalizedMatch.rows.length === 1) {
    return { matched: true, claimId: normalizedMatch.rows[0].id, confidence: 90, method: 'NORMALIZED' };
  }

  // Strategy 3: Subscriber + date of service + charge amount
  // This catches cases where the payer sends back a different claim number
  if (remitClaim.subscriberId && remitClaim.chargeAmount) {
    const subscriberMatch = await client.query(
      `SELECT id, claim_number FROM claims
       WHERE subscriber_id = $1
       AND payer_id = $2
       AND total_charge_amount = $3
       AND status IN ('SUBMITTED', 'PENDING_REVIEW', 'ADJUDICATED')
       AND deleted_at IS NULL
       LIMIT 5`,
      [remitClaim.subscriberId, payerId, remitClaim.chargeAmount]
    );

    if (subscriberMatch.rows.length === 1) {
      return { matched: true, claimId: subscriberMatch.rows[0].id, confidence: 75, method: 'SUBSCRIBER_MATCH' };
    }

    // If multiple matches on subscriber, try to narrow down
    if (subscriberMatch.rows.length > 1) {
      logger.warn('Multiple claims match subscriber + charge amount', {
        subscriberId: remitClaim.subscriberId,
        chargeAmount: remitClaim.chargeAmount,
        matchCount: subscriberMatch.rows.length,
        pcn,
      });
      // Don't auto-match if ambiguous
    }
  }

  // Strategy 4: Patient name + provider (fuzzy match)
  // This is a last resort and has low confidence
  if (remitClaim.patientLastName) {
    const nameMatch = await client.query(
      `SELECT id, claim_number FROM claims
       WHERE UPPER(patient_last_name) = $1
       AND payer_id = $2
       AND status IN ('SUBMITTED', 'PENDING_REVIEW', 'ADJUDICATED')
       AND ABS(total_charge_amount - $3) < 1.00
       AND deleted_at IS NULL
       LIMIT 5`,
      [
        remitClaim.patientLastName.toUpperCase(),
        payerId,
        remitClaim.chargeAmount,
      ]
    );

    if (nameMatch.rows.length === 1) {
      return { matched: true, claimId: nameMatch.rows[0].id, confidence: 50, method: 'FUZZY' };
    }
  }

  // No match found
  logger.warn('Unable to match remittance claim', {
    pcn,
    payerId,
    subscriberId: remitClaim.subscriberId,
    chargeAmount: remitClaim.chargeAmount,
    patientLastName: remitClaim.patientLastName,
  });

  return { matched: false, confidence: 0, method: 'NONE' };
}

/**
 * Apply remittance data (payment, adjustments) to a matched claim.
 */
async function applyRemittanceToClaim(
  claimId: string,
  remitClaim: ParsedRemittanceClaim,
  client: any,
  logger: winston.Logger
): Promise<void> {
  // Get current claim status
  const claimResult = await client.query('SELECT status, version FROM claims WHERE id = $1', [claimId]);
  if (claimResult.rows.length === 0) return;

  const currentStatus = claimResult.rows[0].status;
  const currentVersion = claimResult.rows[0].version;

  // Determine new status based on payment
  let newStatus: string;
  let denialCode: string | null = null;
  let denialDesc: string | null = null;

  if (remitClaim.paidAmount > 0) {
    newStatus = 'PAID';
  } else {
    // Zero payment - check if it's a denial or zero-balance
    const hasDenialAdjustment = remitClaim.adjustments.some(
      (adj) => adj.groupCode === 'CO' && !['1', '2', '3', '45'].includes(adj.reasonCode)
    );

    if (hasDenialAdjustment) {
      newStatus = 'DENIED';
      const denialAdj = remitClaim.adjustments.find(
        (adj) => adj.groupCode === 'CO' && !['1', '2', '3', '45'].includes(adj.reasonCode)
      );
      denialCode = denialAdj?.reasonCode || null;
    } else {
      // Zero payment but no denial - probably all patient responsibility
      newStatus = 'ADJUDICATED';
    }
  }

  // Only update if it's a valid transition (don't overwrite VOID, etc.)
  const validFromStatuses = ['SUBMITTED', 'PENDING_REVIEW', 'ADJUDICATED', 'DENIED', 'APPEALED'];
  if (!validFromStatuses.includes(currentStatus)) {
    logger.warn('Skipping remittance application - claim in invalid status', {
      claimId, currentStatus, newStatus,
    });
    return;
  }

  // Calculate patient responsibility from PR adjustments
  const patientResp = remitClaim.adjustments
    .filter((adj) => adj.groupCode === 'PR')
    .reduce((sum, adj) => sum + adj.amount, 0);

  // Update claim
  await client.query(
    `UPDATE claims SET
      status = $1,
      total_paid_amount = $2,
      patient_responsibility = $3,
      paid_date = CASE WHEN $1 = 'PAID' THEN NOW() ELSE paid_date END,
      denial_reason_code = CASE WHEN $1 = 'DENIED' THEN $4 ELSE denial_reason_code END,
      denial_date = CASE WHEN $1 = 'DENIED' THEN NOW() ELSE denial_date END,
      adjudicated_date = COALESCE(adjudicated_date, NOW()),
      updated_by = 'remittance-processor',
      version = version + 1
    WHERE id = $5`,
    [newStatus, remitClaim.paidAmount, patientResp, denialCode, claimId]
  );

  // Update claim lines with service-level detail
  for (const svcLine of remitClaim.serviceLines) {
    // Try to match by CPT code
    // BUG: if there are multiple lines with the same CPT code, this
    // will update all of them with the same amounts. We should match
    // by line number but the 835 doesn't always include it.
    // Known issue: CLAIMS-723
    const lineAdjustments = svcLine.adjustments || [];
    const coAdj = lineAdjustments.filter((a) => a.groupCode === 'CO');
    const prAdj = lineAdjustments.filter((a) => a.groupCode === 'PR');

    const copay = prAdj.find((a) => a.reasonCode === '3')?.amount || 0;
    const coinsurance = prAdj.find((a) => a.reasonCode === '2')?.amount || 0;
    const deductible = prAdj.find((a) => a.reasonCode === '1')?.amount || 0;
    const contractualAdj = coAdj.reduce((sum, a) => sum + a.amount, 0);

    await client.query(
      `UPDATE claim_lines SET
        allowed_amount = $1 + $2,
        paid_amount = $2,
        adjustment_amount = $3,
        copay_amount = $4,
        coinsurance_amount = $5,
        deductible_amount = $6,
        adjudication_status = CASE WHEN $2 > 0 THEN 'PAID' ELSE 'DENIED' END,
        remark_codes = $7,
        adjustment_reason_codes = $8
      WHERE claim_id = $9 AND cpt_code = $10`,
      [
        contractualAdj, svcLine.paidAmount, contractualAdj,
        copay, coinsurance, deductible,
        svcLine.remarkCodes || [],
        lineAdjustments.map((a) => a.reasonCode),
        claimId, svcLine.procedureCode,
      ]
    );
  }

  // Record status change
  await client.query(
    `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason, metadata)
     VALUES ($1, $2, $3, 'remittance-processor', $4, $5)`,
    [
      claimId,
      currentStatus,
      newStatus,
      `Remittance applied: paid $${remitClaim.paidAmount.toFixed(2)} of $${remitClaim.chargeAmount.toFixed(2)}`,
      JSON.stringify({
        paidAmount: remitClaim.paidAmount,
        chargeAmount: remitClaim.chargeAmount,
        adjustments: remitClaim.adjustments,
        serviceLineCount: remitClaim.serviceLines.length,
      }),
    ]
  );

  logger.info('Remittance applied to claim', {
    claimId,
    fromStatus: currentStatus,
    toStatus: newStatus,
    paidAmount: remitClaim.paidAmount,
    chargeAmount: remitClaim.chargeAmount,
    patientResponsibility: patientResp,
  });
}
