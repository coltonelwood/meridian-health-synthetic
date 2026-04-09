/**
 * ERA/835 Remittance Processing Workflow
 *
 * Processes Electronic Remittance Advice (ERA/835) files from payers.
 * These files contain payment information, adjustments, and denial details
 * for previously submitted claims.
 *
 * The matching logic is the most complex part - payers are inconsistent
 * in how they reference original claims. We match on:
 * 1. Claim tracking number (most reliable)
 * 2. Patient + service date + amount (fallback)
 * 3. Subscriber ID + procedure code (last resort)
 *
 * Some payers send a single 835 with hundreds of claims. This workflow
 * handles them in batches to avoid timeouts.
 *
 * Owner: Revenue Cycle team
 * Related: submit-claim.ts, appeal-denial.ts
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { ERA835Parser, RemittanceRecord, AdjustmentDetail } from '@meridian/era-parser';
import { ClaimService, Claim } from '@meridian/claims-service-client';
import { PaymentService } from '@meridian/payment-service-client';
import { PatientService } from '@meridian/patient-service-client';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';
import { Money } from '@meridian/shared-utils';
import { AppError } from '@meridian/shared-utils';

const logger = new HIPAALogger({ service: 'remittance-processing-workflow' });

// --- Types -------------------------------------------------------------------

interface RemittanceInput {
  fileId: string;
  fileName: string;
  fileContent: Buffer;
  payerId: string;
  receivedDate: string;
  source: 'clearinghouse' | 'direct' | 'manual_upload';
}

interface RemittanceState {
  input: RemittanceInput;
  parsedRecords: ParsedRemittanceRecord[];
  matchResults: MatchResult[];
  paymentPostings: PaymentPosting[];
  denials: DenialRecord[];
  balanceUpdates: BalanceUpdate[];
  summary: ProcessingSummary;
  errors: ProcessingError[];
}

interface ParsedRemittanceRecord {
  claimTrackingNumber?: string;
  patientControlNumber?: string;
  subscriberId: string;
  patientName: string;
  serviceDate: string;
  procedureCode: string;
  chargeAmount: number; // cents
  paidAmount: number; // cents
  adjustments: AdjustmentDetail[];
  claimStatus: 'paid' | 'denied' | 'partial';
  remarkCodes: string[];
  checkNumber?: string;
  paymentDate: string;
}

interface MatchResult {
  remittanceIndex: number;
  claimId: string | null;
  matchMethod: 'tracking_number' | 'patient_service_amount' | 'subscriber_procedure' | 'manual' | 'unmatched';
  confidence: number; // 0-1
  warnings: string[];
}

interface PaymentPosting {
  claimId: string;
  paymentAmount: number; // cents
  adjustmentAmount: number; // cents
  patientResponsibility: number; // cents
  checkNumber?: string;
  paymentDate: string;
  postedAt: string;
}

interface DenialRecord {
  claimId: string;
  remittanceIndex: number;
  denialReasonCode: string;
  denialReasonDescription: string;
  remarkCodes: string[];
  appealable: boolean;
  autoAppealEligible: boolean;
}

interface BalanceUpdate {
  patientId: string;
  claimId: string;
  previousBalance: number;
  newBalance: number;
  adjustmentReason: string;
}

interface ProcessingSummary {
  totalRecords: number;
  matched: number;
  unmatched: number;
  paymentsPosted: number;
  totalPaid: number;
  totalAdjusted: number;
  totalPatientResponsibility: number;
  denialsProcessed: number;
  autoAppealsQueued: number;
  processingTimeMs: number;
}

interface ProcessingError {
  recordIndex: number;
  step: string;
  error: string;
  claimId?: string;
}

// --- Step 1: Parse 835 File --------------------------------------------------

const parseFileStep: WorkflowStep<RemittanceState> = {
  name: 'parse_835_file',
  timeout: 30000,
  retries: 0,

  async execute(ctx: WorkflowContext<RemittanceState>): Promise<void> {
    const { fileContent, fileName, payerId } = ctx.state.input;

    logger.info('Parsing 835 remittance file', {
      action: 'REMITTANCE_PARSE_START',
      fileId: ctx.state.input.fileId,
      fileName,
      payerId,
    });

    const parser = new ERA835Parser();

    try {
      const records = await parser.parse(fileContent, {
        payerId,
        // Some payers use non-standard delimiters. Looking at you, Aetna.
        autoDetectDelimiters: true,
        // Handle the ISA/GS envelope
        unwrapEnvelope: true,
      });

      ctx.state.parsedRecords = records.map((r: RemittanceRecord) => ({
        claimTrackingNumber: r.claimTrackingNumber || undefined,
        patientControlNumber: r.patientControlNumber || undefined,
        subscriberId: r.subscriberId,
        patientName: r.patientName,
        serviceDate: r.serviceDate,
        procedureCode: r.procedureCode,
        chargeAmount: r.chargeAmount,
        paidAmount: r.paidAmount,
        adjustments: r.adjustments,
        claimStatus: determineClaimStatus(r),
        remarkCodes: r.remarkCodes || [],
        checkNumber: r.checkNumber,
        paymentDate: r.paymentDate,
      }));

      logger.info('835 file parsed successfully', {
        action: 'REMITTANCE_PARSED',
        fileId: ctx.state.input.fileId,
        recordCount: ctx.state.parsedRecords.length,
      });
    } catch (error: any) {
      logger.error('Failed to parse 835 file', {
        action: 'REMITTANCE_PARSE_FAILED',
        fileId: ctx.state.input.fileId,
        error: error.message,
      });
      throw new AppError(`Failed to parse 835 file: ${error.message}`, 'PARSE_ERROR');
    }
  },
};

function determineClaimStatus(record: RemittanceRecord): 'paid' | 'denied' | 'partial' {
  if (record.paidAmount === 0) return 'denied';
  if (record.paidAmount < record.chargeAmount) return 'partial';
  return 'paid';
}

// --- Step 2: Match to Claims -------------------------------------------------

const matchToClaimsStep: WorkflowStep<RemittanceState> = {
  name: 'match_to_claims',
  timeout: 60000, // can be slow for large files
  retries: 1,

  async execute(ctx: WorkflowContext<RemittanceState>): Promise<void> {
    const claimService = new ClaimService();
    const matchResults: MatchResult[] = [];

    logger.info('Matching remittance records to claims', {
      action: 'REMITTANCE_MATCH_START',
      fileId: ctx.state.input.fileId,
      recordCount: ctx.state.parsedRecords.length,
    });

    // Process in batches to avoid overwhelming the database
    const BATCH_SIZE = 50;
    for (let i = 0; i < ctx.state.parsedRecords.length; i += BATCH_SIZE) {
      const batch = ctx.state.parsedRecords.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (record, batchIdx) => {
          const recordIndex = i + batchIdx;
          return matchSingleRecord(claimService, record, recordIndex);
        })
      );

      matchResults.push(...batchResults);
    }

    ctx.state.matchResults = matchResults;

    const matched = matchResults.filter(r => r.claimId !== null);
    const unmatched = matchResults.filter(r => r.claimId === null);

    logger.info('Remittance matching complete', {
      action: 'REMITTANCE_MATCH_COMPLETE',
      fileId: ctx.state.input.fileId,
      totalRecords: matchResults.length,
      matched: matched.length,
      unmatched: unmatched.length,
      lowConfidence: matchResults.filter(r => r.confidence < 0.8 && r.claimId).length,
    });

    // If more than 20% unmatched, flag for review
    // This usually means the payer changed their format or we have a data issue
    const unmatchedRate = unmatched.length / matchResults.length;
    if (unmatchedRate > 0.2) {
      logger.warn('High unmatched rate in remittance file', {
        action: 'REMITTANCE_HIGH_UNMATCHED',
        fileId: ctx.state.input.fileId,
        unmatchedRate: Math.round(unmatchedRate * 100),
        payerId: ctx.state.input.payerId,
      });
    }
  },
};

async function matchSingleRecord(
  claimService: ClaimService,
  record: ParsedRemittanceRecord,
  recordIndex: number
): Promise<MatchResult> {
  const warnings: string[] = [];

  // Strategy 1: Match by tracking number (most reliable)
  if (record.claimTrackingNumber) {
    const claim = await claimService.findByTrackingNumber(record.claimTrackingNumber);
    if (claim) {
      // Verify the amounts roughly match (allow for adjustments)
      if (Math.abs(claim.totalCharge - record.chargeAmount) > 100) { // $1 tolerance
        warnings.push(
          `Charge amount mismatch: claim=${Money.format(claim.totalCharge)}, ` +
          `remittance=${Money.format(record.chargeAmount)}`
        );
      }
      return {
        remittanceIndex: recordIndex,
        claimId: claim.id,
        matchMethod: 'tracking_number',
        confidence: 1.0,
        warnings,
      };
    }
  }

  // Strategy 2: Match by patient + service date + amount
  // This is less reliable because a patient could have multiple claims
  // on the same date with the same amount (e.g., bilateral procedures)
  if (record.patientControlNumber) {
    const claims = await claimService.findByPatientAndDate({
      subscriberId: record.subscriberId,
      serviceDate: record.serviceDate,
      chargeAmount: record.chargeAmount,
    });

    if (claims.length === 1) {
      return {
        remittanceIndex: recordIndex,
        claimId: claims[0].id,
        matchMethod: 'patient_service_amount',
        confidence: 0.85,
        warnings,
      };
    }

    if (claims.length > 1) {
      warnings.push(`Multiple claims matched (${claims.length}), using most recent`);
      // Pick the most recently submitted one
      const sorted = claims.sort((a: Claim, b: Claim) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
      );
      return {
        remittanceIndex: recordIndex,
        claimId: sorted[0].id,
        matchMethod: 'patient_service_amount',
        confidence: 0.6,
        warnings,
      };
    }
  }

  // Strategy 3: Match by subscriber ID + procedure code (last resort)
  const claims = await claimService.findBySubscriberAndProcedure({
    subscriberId: record.subscriberId,
    procedureCode: record.procedureCode,
    payerId: record.subscriberId, // This is wrong - it should be the payer ID
    // BUG: We're passing subscriberId as payerId. This has been here since the
    // initial implementation and somehow hasn't caused major issues because
    // the service ignores payerId in the query if subscriberId matches.
    // TODO: Fix this. Ticket: MH-4521
  });

  if (claims.length === 1) {
    return {
      remittanceIndex: recordIndex,
      claimId: claims[0].id,
      matchMethod: 'subscriber_procedure',
      confidence: 0.5,
      warnings: [...warnings, 'Matched by subscriber+procedure only - verify manually'],
    };
  }

  // Unmatched
  return {
    remittanceIndex: recordIndex,
    claimId: null,
    matchMethod: 'unmatched',
    confidence: 0,
    warnings: [...warnings, 'Could not match to any claim in system'],
  };
}

// --- Step 3: Post Payments ---------------------------------------------------

const postPaymentsStep: WorkflowStep<RemittanceState> = {
  name: 'post_payments',
  timeout: 60000,
  retries: 1,

  async execute(ctx: WorkflowContext<RemittanceState>): Promise<void> {
    const paymentService = new PaymentService();
    const postings: PaymentPosting[] = [];

    logger.info('Posting payments from remittance', {
      action: 'PAYMENT_POST_START',
      fileId: ctx.state.input.fileId,
    });

    for (const match of ctx.state.matchResults) {
      if (!match.claimId || match.matchMethod === 'unmatched') continue;

      const record = ctx.state.parsedRecords[match.remittanceIndex];

      if (record.paidAmount === 0 && record.claimStatus === 'denied') {
        continue; // Denials are handled in the next step
      }

      try {
        // Calculate patient responsibility from adjustments
        const patientResponsibility = record.adjustments
          .filter((a: AdjustmentDetail) =>
            a.groupCode === 'PR' // Patient Responsibility group
          )
          .reduce((sum: number, a: AdjustmentDetail) => sum + a.amount, 0);

        const contractualAdjustment = record.adjustments
          .filter((a: AdjustmentDetail) =>
            a.groupCode === 'CO' // Contractual Obligation
          )
          .reduce((sum: number, a: AdjustmentDetail) => sum + a.amount, 0);

        await paymentService.postPayment({
          claimId: match.claimId,
          paymentAmount: record.paidAmount,
          adjustmentAmount: contractualAdjustment,
          patientResponsibility,
          checkNumber: record.checkNumber,
          paymentDate: record.paymentDate,
          remittanceFileId: ctx.state.input.fileId,
          matchConfidence: match.confidence,
          matchMethod: match.matchMethod,
        });

        postings.push({
          claimId: match.claimId,
          paymentAmount: record.paidAmount,
          adjustmentAmount: contractualAdjustment,
          patientResponsibility,
          checkNumber: record.checkNumber,
          paymentDate: record.paymentDate,
          postedAt: new Date().toISOString(),
        });
      } catch (error: any) {
        ctx.state.errors.push({
          recordIndex: match.remittanceIndex,
          step: 'post_payments',
          error: error.message,
          claimId: match.claimId,
        });

        logger.error('Failed to post payment', {
          action: 'PAYMENT_POST_FAILED',
          claimId: match.claimId,
          error: error.message,
        });
      }
    }

    ctx.state.paymentPostings = postings;

    logger.info('Payment posting complete', {
      action: 'PAYMENT_POST_COMPLETE',
      fileId: ctx.state.input.fileId,
      paymentsPosted: postings.length,
      totalPaid: postings.reduce((sum, p) => sum + p.paymentAmount, 0),
    });
  },
};

// --- Step 4: Handle Denials --------------------------------------------------

const handleDenialsStep: WorkflowStep<RemittanceState> = {
  name: 'handle_denials',
  timeout: 30000,
  retries: 1,

  async execute(ctx: WorkflowContext<RemittanceState>): Promise<void> {
    const claimService = new ClaimService();
    const denials: DenialRecord[] = [];

    const deniedRecords = ctx.state.matchResults.filter(match => {
      if (!match.claimId) return false;
      const record = ctx.state.parsedRecords[match.remittanceIndex];
      return record.claimStatus === 'denied';
    });

    logger.info('Processing denials', {
      action: 'DENIAL_PROCESSING_START',
      fileId: ctx.state.input.fileId,
      denialCount: deniedRecords.length,
    });

    // CARC (Claim Adjustment Reason Codes) that are auto-appealable
    // These are common denials that we can automatically appeal
    const AUTO_APPEAL_CODES = [
      '4',   // The procedure code is inconsistent with the modifier used
      '16',  // Claim/service lacks information needed for adjudication
      '18',  // Exact duplicate claim/service
      '29',  // The time limit for filing has expired
      '197', // Precertification/authorization/notification absent
    ];

    for (const match of deniedRecords) {
      const record = ctx.state.parsedRecords[match.remittanceIndex];

      // Extract the primary denial reason from adjustments
      const denialAdjustment = record.adjustments.find(
        (a: AdjustmentDetail) => a.groupCode === 'CO' || a.groupCode === 'OA'
      );

      const denialReasonCode = denialAdjustment?.reasonCode || 'UNKNOWN';
      const denialReasonDescription = denialAdjustment?.reasonDescription ||
        mapReasonCode(denialReasonCode);

      const autoAppealEligible = AUTO_APPEAL_CODES.includes(denialReasonCode) &&
        match.confidence >= 0.8; // Only auto-appeal high-confidence matches

      const denial: DenialRecord = {
        claimId: match.claimId!,
        remittanceIndex: match.remittanceIndex,
        denialReasonCode,
        denialReasonDescription,
        remarkCodes: record.remarkCodes,
        appealable: true, // Most denials are appealable
        autoAppealEligible,
      };

      denials.push(denial);

      // Update the claim status
      await claimService.updateClaim(match.claimId!, {
        status: 'denied',
        denialReasonCode,
        denialReasonDescription,
        remarkCodes: record.remarkCodes,
      });

      // If auto-appeal eligible, queue the appeal workflow
      if (autoAppealEligible) {
        const eventBus = new EventBus();
        await eventBus.publish('claim.denial.auto_appeal', {
          claimId: match.claimId,
          denialReasonCode,
          remarkCodes: record.remarkCodes,
          originalChargeAmount: record.chargeAmount,
          payerId: ctx.state.input.payerId,
        });
      }
    }

    ctx.state.denials = denials;

    logger.info('Denial processing complete', {
      action: 'DENIAL_PROCESSING_COMPLETE',
      fileId: ctx.state.input.fileId,
      denialsProcessed: denials.length,
      autoAppealsQueued: denials.filter(d => d.autoAppealEligible).length,
    });
  },
};

function mapReasonCode(code: string): string {
  // Simplified CARC code descriptions
  const codes: Record<string, string> = {
    '1': 'Deductible amount',
    '2': 'Coinsurance amount',
    '3': 'Co-payment amount',
    '4': 'Procedure code inconsistent with modifier',
    '16': 'Missing information',
    '18': 'Duplicate claim',
    '22': 'Coordination of benefits',
    '23': 'Payment adjusted - charges covered under capitation',
    '29': 'Timely filing limit expired',
    '45': 'Charges exceed fee schedule/maximum allowable',
    '50': 'Non-covered service',
    '96': 'Non-covered charge(s)',
    '197': 'Prior authorization absent',
    '204': 'Service not covered by this payer',
  };
  return codes[code] || `Unknown reason code: ${code}`;
}

// --- Step 5: Update Balances -------------------------------------------------

const updateBalancesStep: WorkflowStep<RemittanceState> = {
  name: 'update_balances',
  timeout: 30000,
  retries: 1,

  async execute(ctx: WorkflowContext<RemittanceState>): Promise<void> {
    const patientService = new PatientService();
    const balanceUpdates: BalanceUpdate[] = [];

    logger.info('Updating patient balances', {
      action: 'BALANCE_UPDATE_START',
      fileId: ctx.state.input.fileId,
    });

    for (const posting of ctx.state.paymentPostings) {
      if (posting.patientResponsibility > 0) {
        try {
          const claimService = new ClaimService();
          const claim = await claimService.getClaim(posting.claimId);

          if (!claim) continue;

          const previousBalance = await patientService.getBalance(claim.patientId);

          await patientService.addToBalance(claim.patientId, {
            amount: posting.patientResponsibility,
            claimId: posting.claimId,
            reason: 'Insurance payment posted - patient responsibility',
            checkNumber: posting.checkNumber,
          });

          const newBalance = previousBalance + posting.patientResponsibility;

          balanceUpdates.push({
            patientId: claim.patientId,
            claimId: posting.claimId,
            previousBalance,
            newBalance,
            adjustmentReason: 'Patient responsibility from ERA',
          });

          // If patient now has a balance over $100, queue a statement
          // TODO: Make this threshold configurable per organization.
          // Some orgs want to send statements at $25, others at $200.
          if (newBalance >= 100_00 && previousBalance < 100_00) {
            const eventBus = new EventBus();
            await eventBus.publish('patient.statement.needed', {
              patientId: claim.patientId,
              balance: newBalance,
              claimId: posting.claimId,
            });
          }
        } catch (error: any) {
          ctx.state.errors.push({
            recordIndex: -1,
            step: 'update_balances',
            error: error.message,
            claimId: posting.claimId,
          });
        }
      }
    }

    ctx.state.balanceUpdates = balanceUpdates;

    logger.info('Balance updates complete', {
      action: 'BALANCE_UPDATE_COMPLETE',
      fileId: ctx.state.input.fileId,
      updatesApplied: balanceUpdates.length,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const processRemittanceWorkflow = new WorkflowEngine<RemittanceInput, RemittanceState>({
  name: 'process_remittance',
  version: '3.0.1',
  description: 'Processes ERA/835 remittance files and posts payments',

  initialState: (input: RemittanceInput): RemittanceState => ({
    input,
    parsedRecords: [],
    matchResults: [],
    paymentPostings: [],
    denials: [],
    balanceUpdates: [],
    summary: {
      totalRecords: 0,
      matched: 0,
      unmatched: 0,
      paymentsPosted: 0,
      totalPaid: 0,
      totalAdjusted: 0,
      totalPatientResponsibility: 0,
      denialsProcessed: 0,
      autoAppealsQueued: 0,
      processingTimeMs: 0,
    },
    errors: [],
  }),

  steps: [
    parseFileStep,
    matchToClaimsStep,
    postPaymentsStep,
    handleDenialsStep,
    updateBalancesStep,
  ],

  criticalSteps: ['parse_835_file', 'match_to_claims'],
  bestEffortSteps: ['update_balances'],

  hooks: {
    onComplete: async (ctx) => {
      // Build final summary
      ctx.state.summary = {
        totalRecords: ctx.state.parsedRecords.length,
        matched: ctx.state.matchResults.filter(r => r.claimId !== null).length,
        unmatched: ctx.state.matchResults.filter(r => r.claimId === null).length,
        paymentsPosted: ctx.state.paymentPostings.length,
        totalPaid: ctx.state.paymentPostings.reduce((s, p) => s + p.paymentAmount, 0),
        totalAdjusted: ctx.state.paymentPostings.reduce((s, p) => s + p.adjustmentAmount, 0),
        totalPatientResponsibility: ctx.state.paymentPostings.reduce(
          (s, p) => s + p.patientResponsibility, 0
        ),
        denialsProcessed: ctx.state.denials.length,
        autoAppealsQueued: ctx.state.denials.filter(d => d.autoAppealEligible).length,
        processingTimeMs: ctx.duration,
      };

      logger.info('Remittance processing workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        fileId: ctx.state.input.fileId,
        ...ctx.state.summary,
      });
    },
  },
});

export type { RemittanceInput, RemittanceState, ProcessingSummary };
