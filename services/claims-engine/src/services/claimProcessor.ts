/**
 * Core claim processing logic.
 *
 * This is the heart of the claims engine. It takes a submitted claim,
 * validates it against payer rules, checks eligibility (sort of),
 * generates X12 837 transactions, and sends them to the clearinghouse.
 *
 * TODO: refactor this monster
 *
 * This file has grown organically over 2 years and it shows. The nested
 * if/else blocks are hard to follow, the payer-specific logic should be
 * in a rules engine, and the error handling is inconsistent.
 *
 * Nobody wants to touch it because it works and claims processing is
 * unforgiving - a bug here means rejected claims and angry providers.
 *
 * Technical debt items:
 * - Break into smaller functions
 * - Move payer rules to config/database
 * - Add proper retry logic (not just try/catch and log)
 * - The eligibility check is a fake placeholder
 * - Fee schedule lookup is hardcoded
 * - X12 generation should use a proper library
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import winston from 'winston';
import { Claim, ClaimStatus, claimFromRow, ClaimType, FilingIndicator } from '../models/Claim';
import { ClaimLine, claimLineFromRow } from '../models/ClaimLine';
import { getPayerConfig, normalizePayerId, requiresPriorAuth } from '../utils/payerRules';
import { lookupCptCode, isValidCptFormat, isKnownCptCode } from '../utils/cptLookup';
import { generateX12_837 } from './x12Parser';
import { runAdjudication } from './adjudicationEngine';

/**
 * Validate a claim before submission. Returns an array of error messages.
 * Empty array means the claim is valid.
 */
export function validateClaimForSubmission(claim: Claim, lines: ClaimLine[]): string[] {
  const errors: string[] = [];

  // Basic required fields
  if (!claim.subscriberId) errors.push('Subscriber ID is required');
  if (!claim.patient.patientId) errors.push('Patient ID is required');
  if (!claim.provider.billingProviderNpi) errors.push('Billing provider NPI is required');
  if (!claim.payer.payerId) errors.push('Payer ID is required');
  if (!claim.diagnosisCodes || claim.diagnosisCodes.length === 0) {
    errors.push('At least one diagnosis code is required');
  }
  if (!claim.serviceDateFrom) errors.push('Service date is required');

  // NPI validation (Luhn check)
  if (claim.provider.billingProviderNpi && !isValidNpi(claim.provider.billingProviderNpi)) {
    errors.push('Billing provider NPI is invalid (failed Luhn check)');
  }
  if (claim.provider.renderingProviderNpi && !isValidNpi(claim.provider.renderingProviderNpi)) {
    errors.push('Rendering provider NPI is invalid');
  }

  // Diagnosis code validation
  if (claim.diagnosisCodes) {
    for (const dx of claim.diagnosisCodes) {
      if (!isValidIcd10(dx)) {
        errors.push(`Invalid ICD-10 code: ${dx}`);
      }
    }
  }

  // Line item validation
  if (!lines || lines.length === 0) {
    errors.push('Claim must have at least one line item');
  } else {
    for (const line of lines) {
      if (!isValidCptFormat(line.cptCode)) {
        errors.push(`Line ${line.lineNumber}: Invalid CPT code format: ${line.cptCode}`);
      }
      if (line.chargeAmount <= 0) {
        errors.push(`Line ${line.lineNumber}: Charge amount must be positive`);
      }
      if (line.units <= 0) {
        errors.push(`Line ${line.lineNumber}: Units must be positive`);
      }
      // Check diagnosis pointer references valid diagnosis codes
      if (line.diagnosisPointer) {
        for (const ptr of line.diagnosisPointer) {
          if (ptr < 1 || ptr > (claim.diagnosisCodes?.length || 0)) {
            errors.push(`Line ${line.lineNumber}: Diagnosis pointer ${ptr} references non-existent diagnosis code`);
          }
        }
      }
    }
  }

  // Service date validation
  if (claim.serviceDateFrom) {
    const serviceDate = new Date(claim.serviceDateFrom);
    const now = new Date();
    if (serviceDate > now) {
      errors.push('Service date cannot be in the future');
    }
    // Check timely filing
    const daysSinceService = Math.floor((now.getTime() - serviceDate.getTime()) / (1000 * 60 * 60 * 24));
    const payerConfig = getPayerConfig(claim.payer.payerId);
    const timelyFilingDays = payerConfig?.timelyFilingDays || 365;
    if (daysSinceService > timelyFilingDays) {
      errors.push(`Claim exceeds timely filing limit of ${timelyFilingDays} days for this payer`);
    }
  }

  // Institutional claim specific validation
  if (claim.claimType === ClaimType.INSTITUTIONAL) {
    if (!claim.admissionDate) {
      errors.push('Admission date is required for institutional claims');
    }
    // Check that all lines have revenue codes
    for (const line of lines) {
      if (!line.revenueCode) {
        errors.push(`Line ${line.lineNumber}: Revenue code is required for institutional claims`);
      }
    }
  }

  // Payer-specific validation
  const payerConfig = getPayerConfig(claim.payer.payerId);
  if (payerConfig) {
    if (payerConfig.requiresRefPhysician && !claim.provider.referringProviderNpi) {
      errors.push(`${payerConfig.payerName} requires a referring provider NPI`);
    }
    if (payerConfig.maxLinesPerClaim && lines.length > payerConfig.maxLinesPerClaim) {
      errors.push(`${payerConfig.payerName} allows a maximum of ${payerConfig.maxLinesPerClaim} lines per claim`);
    }

    // Check for prior auth requirement
    for (const line of lines) {
      if (requiresPriorAuth(claim.payer.payerId, line.cptCode) && !claim.payer.priorAuthNumber) {
        errors.push(`Line ${line.lineNumber}: Prior authorization required for ${line.cptCode} with ${payerConfig.payerName}`);
      }
    }
  }

  return errors;
}

/**
 * Process a submitted claim. This is the main processing pipeline.
 *
 * Steps:
 * 1. Load claim and lines from DB
 * 2. Normalize payer info
 * 3. Apply payer-specific rules
 * 4. Check eligibility (placeholder)
 * 5. Generate X12 837
 * 6. Submit to clearinghouse (placeholder)
 * 7. Run auto-adjudication if eligible
 */
export async function processClaim(
  claimId: string,
  pool: Pool,
  redis: Redis,
  logger: winston.Logger
): Promise<void> {
  logger.info('Starting claim processing', { claimId });

  // Step 1: Load claim
  const [claimResult, linesResult] = await Promise.all([
    pool.query('SELECT * FROM claims WHERE id = $1', [claimId]),
    pool.query('SELECT * FROM claim_lines WHERE claim_id = $1 ORDER BY line_number', [claimId]),
  ]);

  if (claimResult.rows.length === 0) {
    throw new Error(`Claim ${claimId} not found`);
  }

  const claim = claimFromRow(claimResult.rows[0]);
  const lines = linesResult.rows.map(claimLineFromRow);

  if (claim.status !== ClaimStatus.SUBMITTED) {
    logger.warn('Claim is not in SUBMITTED status, skipping processing', {
      claimId, currentStatus: claim.status,
    });
    return;
  }

  try {
    // Step 2: Normalize payer ID
    const normalizedPayerId = normalizePayerId(claim.payer.payerId);
    if (normalizedPayerId !== claim.payer.payerId) {
      await pool.query('UPDATE claims SET payer_id = $1 WHERE id = $2', [normalizedPayerId, claimId]);
      logger.info('Normalized payer ID', { claimId, from: claim.payer.payerId, to: normalizedPayerId });
    }

    // Step 3: Apply payer-specific rules
    const payerConfig = getPayerConfig(normalizedPayerId);
    if (payerConfig) {
      const ruleResults = await applyPayerRules(claim, lines, payerConfig, pool, logger);

      // If any rule results in a denial, stop processing
      if (ruleResults.denied) {
        await updateClaimStatus(claimId, ClaimStatus.SUBMITTED, ClaimStatus.DENIED, pool, 'system', ruleResults.denialReason || 'Payer rule violation');
        await pool.query(
          `UPDATE claims SET denial_reason_code = $1, denial_reason_description = $2, denial_date = NOW(),
           appeal_deadline = NOW() + INTERVAL '${payerConfig.appealTimelyFilingDays || 180} days'
           WHERE id = $3`,
          [ruleResults.denialCode || '96', ruleResults.denialReason, claimId]
        );
        logger.info('Claim denied by payer rules', { claimId, reason: ruleResults.denialReason });
        return;
      }

      // If rules flagged for review, route to manual
      if (ruleResults.needsReview) {
        await updateClaimStatus(claimId, ClaimStatus.SUBMITTED, ClaimStatus.PENDING_REVIEW, pool, 'system', ruleResults.reviewReason || 'Flagged by payer rules');
        logger.info('Claim routed to manual review', { claimId, reason: ruleResults.reviewReason });
        return;
      }
    }

    // Step 4: "Eligibility check"
    // This is supposed to call the eligibility service to verify the patient
    // has active coverage. Right now it just... doesn't. We check eligibility
    // at the front-end when the claim is being created, and assume it's still
    // valid by the time we process it. This is a known gap.
    // TODO: integrate with eligibility service (CLAIMS-567)
    const isEligible = await checkEligibility(claim, redis, logger);
    if (!isEligible) {
      // This code path never executes because checkEligibility always returns true
      // but I'm leaving it here for when we actually implement it
      await updateClaimStatus(claimId, ClaimStatus.SUBMITTED, ClaimStatus.DENIED, pool, 'system', 'Patient not eligible');
      await pool.query(
        `UPDATE claims SET denial_reason_code = '27', denial_reason_description = 'Patient eligibility could not be verified', denial_date = NOW() WHERE id = $1`,
        [claimId]
      );
      return;
    }

    // Step 5: Generate X12 837
    let x12Transaction: string | null = null;
    try {
      x12Transaction = generateX12_837(claim, lines);
      logger.debug('X12 837 generated', { claimId, length: x12Transaction?.length });
    } catch (err: any) {
      logger.error('Failed to generate X12 837', { claimId, error: err.message });
      // Don't fail the claim for this - we can generate it later
      // Some payers accept our proprietary format anyway
    }

    if (x12Transaction) {
      await pool.query(
        `UPDATE claims SET original_x12_transaction_id = $1 WHERE id = $2`,
        [x12Transaction.substring(0, 100), claimId]  // just store a reference, not the whole thing
      );
    }

    // Step 6: Submit to clearinghouse
    // This is where we'd actually send the claim to the clearinghouse (e.g., Change Healthcare, Availity)
    // For now, we just pretend it worked and move on.
    // The actual submission happens in a separate microservice (edi-gateway) that
    // we communicate with via... you guessed it, another RabbitMQ queue.
    // But for claims that come through this synchronous path, we just log it.
    logger.info('Claim would be submitted to clearinghouse', {
      claimId,
      clearinghouse: payerConfig?.clearinghouseId || 'UNKNOWN',
      method: payerConfig?.submissionMethod || 'EDI',
    });

    // Update submission batch ID
    const batchId = `BATCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    await pool.query(
      `UPDATE claims SET submission_batch_id = $1 WHERE id = $2`,
      [batchId, claimId]
    );

    // Step 7: Auto-adjudication (if eligible)
    if (payerConfig?.autoAdjudicateEligible !== false) {
      try {
        logger.info('Running auto-adjudication', { claimId });
        const adjResult = await runAdjudication(claim, lines, pool, redis, logger);

        if (adjResult.approved) {
          await pool.query(
            `UPDATE claims SET
              status = 'ADJUDICATED',
              total_paid_amount = $1,
              patient_responsibility = $2,
              adjudicated_date = NOW(),
              updated_by = 'system',
              version = version + 1
            WHERE id = $3`,
            [adjResult.totalPaidAmount, adjResult.patientResponsibility, claimId]
          );

          // Update line items
          for (const lineResult of adjResult.lineResults) {
            await pool.query(
              `UPDATE claim_lines SET
                allowed_amount = $1, paid_amount = $2, adjustment_amount = $3,
                copay_amount = $4, coinsurance_amount = $5, deductible_amount = $6,
                adjudication_status = $7, remark_codes = $8, adjustment_reason_codes = $9
              WHERE id = $10`,
              [
                lineResult.allowedAmount, lineResult.paidAmount, lineResult.adjustmentAmount,
                lineResult.copayAmount, lineResult.coinsuranceAmount, lineResult.deductibleAmount,
                lineResult.status, lineResult.remarkCodes || [], lineResult.adjustmentReasonCodes || [],
                lineResult.lineId,
              ]
            );
          }

          await pool.query(
            `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason)
             VALUES ($1, 'SUBMITTED', 'ADJUDICATED', 'system', 'Auto-adjudication approved')`,
            [claimId]
          );

          logger.info('Claim auto-adjudicated and approved', {
            claimId,
            paidAmount: adjResult.totalPaidAmount,
            patientResp: adjResult.patientResponsibility,
          });
        } else {
          // Auto-adjudication denied the claim
          await pool.query(
            `UPDATE claims SET
              status = 'DENIED',
              denial_reason_code = $1,
              denial_reason_description = $2,
              denial_date = NOW(),
              appeal_deadline = NOW() + INTERVAL '${payerConfig?.appealTimelyFilingDays || 180} days',
              updated_by = 'system',
              version = version + 1
            WHERE id = $3`,
            [adjResult.denialReasonCode || '96', adjResult.denialReasonDescription || 'Claim denied by auto-adjudication', claimId]
          );

          await pool.query(
            `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason)
             VALUES ($1, 'SUBMITTED', 'DENIED', 'system', $2)`,
            [claimId, adjResult.denialReasonDescription || 'Auto-adjudication denied']
          );

          logger.info('Claim auto-adjudicated and denied', {
            claimId,
            denialCode: adjResult.denialReasonCode,
            reason: adjResult.denialReasonDescription,
          });
        }
      } catch (adjErr: any) {
        // If auto-adjudication fails, route to manual review
        // Don't fail the whole claim for this
        logger.error('Auto-adjudication failed, routing to manual review', {
          claimId, error: adjErr.message,
        });
        await updateClaimStatus(claimId, ClaimStatus.SUBMITTED, ClaimStatus.PENDING_REVIEW, pool, 'system', `Auto-adjudication error: ${adjErr.message}`);
      }
    } else {
      // Payer doesn't support auto-adjudication, route to manual
      await updateClaimStatus(claimId, ClaimStatus.SUBMITTED, ClaimStatus.PENDING_REVIEW, pool, 'system', 'Payer requires manual adjudication');
      logger.info('Claim routed to manual review (payer config)', { claimId });
    }

    // Publish status update event
    try {
      await redis.publish('claim:status:updated', JSON.stringify({
        claimId,
        claimNumber: claim.claimNumber,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // Non-critical
    }

    logger.info('Claim processing completed', { claimId });
  } catch (err: any) {
    logger.error('Claim processing failed', { claimId, error: err.message, stack: err.stack });

    // Try to update the claim to PENDING_REVIEW so it doesn't get stuck
    try {
      await updateClaimStatus(claimId, claim.status, ClaimStatus.PENDING_REVIEW, pool, 'system', `Processing error: ${err.message}`);
    } catch (updateErr: any) {
      logger.error('Failed to update claim status after processing error', {
        claimId, error: updateErr.message,
      });
    }

    throw err;
  }
}

// ---- Helper functions ----

interface PayerRuleResult {
  denied: boolean;
  denialCode?: string;
  denialReason?: string;
  needsReview: boolean;
  reviewReason?: string;
  modifications: any[];
}

async function applyPayerRules(
  claim: Claim,
  lines: ClaimLine[],
  payerConfig: any,
  pool: Pool,
  logger: winston.Logger
): Promise<PayerRuleResult> {
  const result: PayerRuleResult = {
    denied: false,
    needsReview: false,
    modifications: [],
  };

  if (!payerConfig.rules || payerConfig.rules.length === 0) {
    return result;
  }

  for (const rule of payerConfig.rules) {
    // This is the part that should be a proper rules engine
    // Instead it's a bunch of if statements. Sorry.
    switch (rule.condition) {
      case 'hasEMWithProcedure': {
        // Check if E&M code is billed with a procedure without modifier 25
        const emLines = lines.filter((l) => {
          const code = parseInt(l.cptCode, 10);
          return code >= 99201 && code <= 99499;
        });
        const procLines = lines.filter((l) => {
          const code = parseInt(l.cptCode, 10);
          return code >= 10000 && code <= 69999;
        });
        if (emLines.length > 0 && procLines.length > 0) {
          for (const emLine of emLines) {
            if (emLine.modifier1 !== '25' && emLine.modifier2 !== '25') {
              if (rule.action === 'requireModifier25') {
                result.needsReview = true;
                result.reviewReason = `E&M code ${emLine.cptCode} billed with procedure but missing modifier 25`;
              }
            }
          }
        }
        break;
      }

      case 'isTelehealthNewPatient': {
        if (claim.provider.placeOfService === '02') {
          const hasNewPatientEM = lines.some((l) => {
            const code = parseInt(l.cptCode, 10);
            return code >= 99202 && code <= 99205;
          });
          if (hasNewPatientEM) {
            result.denied = true;
            result.denialCode = '5';
            result.denialReason = 'Telehealth (POS 02) not covered for new patient visits with this payer';
            return result;
          }
        }
        break;
      }

      case 'isSpecialistVisit': {
        // Rough heuristic: if billing provider != rendering provider, it's likely a specialist
        // This is a terrible way to determine this but we don't have provider specialty data
        if (claim.provider.billingProviderNpi !== claim.provider.renderingProviderNpi
            && claim.provider.renderingProviderNpi
            && !claim.provider.referringProviderNpi) {
          if (rule.action === 'requireReferringProvider') {
            result.needsReview = true;
            result.reviewReason = 'Specialist visit may require referring provider NPI';
          }
        }
        break;
      }

      case 'hasDuplicateEM': {
        const emCodes = lines
          .filter((l) => parseInt(l.cptCode, 10) >= 99201 && parseInt(l.cptCode, 10) <= 99499)
          .map((l) => l.cptCode);
        if (emCodes.length > 1) {
          // Multiple E&M codes on same claim - likely a bundling issue
          result.needsReview = true;
          result.reviewReason = `Multiple E&M codes on same claim: ${emCodes.join(', ')}. May need bundling.`;
        }
        break;
      }

      case 'missingRenderingProvider': {
        if (!claim.provider.renderingProviderNpi) {
          if (rule.action === 'copyBillingToRendering') {
            // Auto-fix: copy billing NPI to rendering
            await pool.query(
              'UPDATE claims SET rendering_provider_npi = billing_provider_npi WHERE id = $1',
              [claim.id]
            );
            result.modifications.push({
              field: 'renderingProviderNpi',
              action: 'copied from billing provider',
              value: claim.provider.billingProviderNpi,
            });
            logger.info('Auto-populated rendering provider from billing', { claimId: claim.id });
          }
        }
        break;
      }

      case 'missingTaxonomy': {
        // We don't actually store taxonomy codes anywhere right now
        // This rule just flags claims for review
        result.needsReview = true;
        result.reviewReason = 'Payer requires taxonomy code - please add manually';
        break;
      }

      case 'isLabService': {
        const hasLabCodes = lines.some((l) => {
          const code = parseInt(l.cptCode, 10);
          return code >= 80000 && code <= 89999;
        });
        if (hasLabCodes && rule.action === 'requireClia') {
          // Check for CLIA number in metadata
          if (!claim.metadata?.cliaNumber) {
            result.needsReview = true;
            result.reviewReason = 'Lab services require CLIA number';
          }
        }
        break;
      }

      case 'isSurgicalProcedure': {
        const hasSurgery = lines.some((l) => {
          const code = parseInt(l.cptCode, 10);
          return code >= 10000 && code <= 69999;
        });
        if (hasSurgery && !claim.payer.priorAuthNumber) {
          result.needsReview = true;
          result.reviewReason = 'Surgical procedure requires prior authorization';
        }
        break;
      }

      default:
        logger.debug('Unknown payer rule condition', { condition: rule.condition, ruleId: rule.id });
    }

    // Short circuit if denied
    if (result.denied) return result;
  }

  return result;
}

/**
 * "Check" eligibility. This is a placeholder.
 * In the real implementation, this would call our eligibility service
 * which would do an X12 270/271 transaction with the payer.
 */
async function checkEligibility(
  claim: Claim,
  redis: Redis,
  logger: winston.Logger
): Promise<boolean> {
  // Check if we have a cached eligibility result (from when the claim was created)
  try {
    const cached = await redis.get(`eligibility:${claim.subscriberId}:${claim.payer.payerId}`);
    if (cached) {
      const result = JSON.parse(cached);
      // Only trust cached results less than 24 hours old
      const cachedAt = new Date(result.checkedAt);
      const hoursSinceCached = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceCached < 24) {
        return result.eligible;
      }
    }
  } catch {
    // Redis error - just return true (assume eligible)
  }

  // TODO: Actually call the eligibility service
  // For now, everyone is eligible! What could go wrong?
  return true;
}

/**
 * Update claim status with history tracking.
 */
async function updateClaimStatus(
  claimId: string,
  fromStatus: ClaimStatus,
  toStatus: ClaimStatus,
  pool: Pool,
  userId: string,
  reason: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE claims SET status = $1, updated_by = $2, version = version + 1 WHERE id = $3`,
      [toStatus, userId, claimId]
    );
    await client.query(
      `INSERT INTO claim_status_history (claim_id, from_status, to_status, changed_by, change_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [claimId, fromStatus, toStatus, userId, reason]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Validate NPI using the Luhn algorithm (mod 10, double-add-double).
 * NPIs are 10 digits. The first digit identifies the type (1=individual, 2=organization).
 */
function isValidNpi(npi: string): boolean {
  if (!npi || npi.length !== 10 || !/^\d{10}$/.test(npi)) return false;

  // NPI uses Luhn with a "80840" prefix for the check digit calculation
  const prefixed = '80840' + npi.substring(0, 9);
  let sum = 0;
  let alternate = false;

  for (let i = prefixed.length - 1; i >= 0; i--) {
    let digit = parseInt(prefixed[i], 10);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(npi[9], 10);
}

/**
 * Basic ICD-10 code format validation.
 * Format: A00-Z99 with optional decimal and up to 4 additional characters.
 * Example: E11.65, M54.5, Z00.00
 */
function isValidIcd10(code: string): boolean {
  if (!code) return false;
  // ICD-10-CM: letter + 2 digits + optional (period + 1-4 alphanum)
  return /^[A-Z]\d{2}(\.\d{1,4})?$/.test(code.trim().toUpperCase());
}
