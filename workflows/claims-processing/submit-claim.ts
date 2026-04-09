/**
 * Claim Submission Workflow
 *
 * Processes an outbound healthcare claim (837P/837I) from validation
 * through clearinghouse submission and status tracking.
 *
 * The clearinghouse integration (currently Change Healthcare / Optum)
 * is notoriously unreliable. The retry logic here was battle-tested during
 * the February 2024 Change Healthcare outage. We added the Availity
 * fallback path after that incident.
 *
 * Owner: Revenue Cycle team
 * SLA: Claims should be submitted within 4 hours of encounter close
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { ClaimService, Claim, ClaimLine } from '@meridian/claims-service-client';
import { ClearinghouseClient, SubmissionResult } from '@meridian/clearinghouse-client';
import { EligibilityClient } from '@meridian/eligibility-client';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';
import { Money } from '@meridian/shared-utils';
import { AppError, ValidationError } from '@meridian/shared-utils';

const logger = new HIPAALogger({ service: 'claim-submission-workflow' });

// --- Types -------------------------------------------------------------------

interface ClaimSubmissionInput {
  claimId: string;
  encounterId: string;
  patientId: string;
  providerId: string;
  facilityId: string;
  claimType: '837P' | '837I'; // Professional vs Institutional
  serviceLines: ServiceLine[];
  diagnosisCodes: DiagnosisCode[];
  payerId: string;
  subscriberId: string;
  priorAuthNumber?: string;
  isResubmission: boolean;
  originalClaimId?: string;
  submittedBy: string;
}

interface ServiceLine {
  lineNumber: number;
  procedureCode: string;
  modifiers: string[];
  diagnosisPointers: number[];
  chargeAmount: number; // cents
  units: number;
  serviceDate: string;
  placeOfService: string;
  renderingProviderId?: string;
}

interface DiagnosisCode {
  code: string;
  type: 'ICD10' | 'ICD9'; // ICD-9 is legacy but some workers comp payers still need it
  sequence: number;
}

interface ClaimSubmissionState {
  input: ClaimSubmissionInput;
  validationResult?: ValidationResult;
  eligibilityConfirmed: boolean;
  scrubResult?: ScrubResult;
  submissionResult?: SubmissionResult;
  trackingNumber?: string;
  clearinghouseUsed?: 'change_healthcare' | 'availity' | 'direct';
  status: ClaimStatus;
  retryCount: number;
  errors: WorkflowError[];
  totalCharge: number; // cents
}

type ClaimStatus =
  | 'validating'
  | 'checking_eligibility'
  | 'scrubbing'
  | 'submitting'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'failed';

interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

interface ScrubResult {
  clean: boolean;
  issues: ScrubIssue[];
  autoFixed: ScrubIssue[];
}

interface ScrubIssue {
  lineNumber?: number;
  ruleId: string;
  description: string;
  category: 'coding' | 'billing' | 'compliance' | 'payer_specific';
  autoFixable: boolean;
}

interface WorkflowError {
  step: string;
  error: string;
  timestamp: string;
  retryable: boolean;
}

// --- Step 1: Validate Claim --------------------------------------------------

const validateClaimStep: WorkflowStep<ClaimSubmissionState> = {
  name: 'validate_claim',
  timeout: 10000,
  retries: 0,

  async execute(ctx: WorkflowContext<ClaimSubmissionState>): Promise<void> {
    ctx.state.status = 'validating';
    const { input } = ctx.state;

    logger.info('Validating claim', {
      action: 'CLAIM_VALIDATION_START',
      claimId: input.claimId,
      claimType: input.claimType,
    });

    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // Required field validation
    if (!input.diagnosisCodes || input.diagnosisCodes.length === 0) {
      errors.push({
        field: 'diagnosisCodes',
        code: 'MISSING_DIAGNOSIS',
        message: 'At least one diagnosis code is required',
        severity: 'error',
      });
    }

    if (!input.serviceLines || input.serviceLines.length === 0) {
      errors.push({
        field: 'serviceLines',
        code: 'MISSING_SERVICE_LINES',
        message: 'At least one service line is required',
        severity: 'error',
      });
    }

    // Validate each service line
    for (const line of input.serviceLines) {
      // CPT code format: 5 digits, optionally followed by a modifier
      if (!/^\d{5}$/.test(line.procedureCode)) {
        errors.push({
          field: `serviceLines[${line.lineNumber}].procedureCode`,
          code: 'INVALID_CPT',
          message: `Invalid CPT code format: ${line.procedureCode}`,
          severity: 'error',
        });
      }

      // Charge amount must be positive
      if (line.chargeAmount <= 0) {
        errors.push({
          field: `serviceLines[${line.lineNumber}].chargeAmount`,
          code: 'INVALID_CHARGE',
          message: 'Charge amount must be greater than zero',
          severity: 'error',
        });
      }

      // Units must be positive
      if (line.units <= 0 || !Number.isInteger(line.units)) {
        errors.push({
          field: `serviceLines[${line.lineNumber}].units`,
          code: 'INVALID_UNITS',
          message: 'Units must be a positive integer',
          severity: 'error',
        });
      }

      // Diagnosis pointers must reference valid diagnosis codes
      for (const ptr of line.diagnosisPointers) {
        if (!input.diagnosisCodes.find(d => d.sequence === ptr)) {
          errors.push({
            field: `serviceLines[${line.lineNumber}].diagnosisPointers`,
            code: 'INVALID_DIAGNOSIS_POINTER',
            message: `Diagnosis pointer ${ptr} does not reference a valid diagnosis`,
            severity: 'error',
          });
        }
      }

      // Modifier validation
      for (const mod of line.modifiers) {
        if (!/^[A-Z0-9]{2}$/.test(mod)) {
          errors.push({
            field: `serviceLines[${line.lineNumber}].modifiers`,
            code: 'INVALID_MODIFIER',
            message: `Invalid modifier format: ${mod}`,
            severity: 'error',
          });
        }
      }

      // Check for potentially unbundled services
      // TODO: This is a naive check. We should use a proper NCCI edit table.
      // The CCI edits change quarterly and we're still using manual updates.
      if (line.procedureCode === '99213' && input.serviceLines.some(
        l => l.procedureCode === '99214' && l.serviceDate === line.serviceDate
      )) {
        warnings.push({
          field: `serviceLines[${line.lineNumber}]`,
          code: 'POTENTIAL_UNBUNDLING',
          message: 'E/M codes 99213 and 99214 on same date of service - verify correct level',
          severity: 'warning',
        });
      }
    }

    // Validate ICD-10 format (A00-Z99 with optional decimal)
    for (const dx of input.diagnosisCodes) {
      if (dx.type === 'ICD10' && !/^[A-Z]\d{2}(\.\d{1,4})?$/.test(dx.code)) {
        errors.push({
          field: `diagnosisCodes[${dx.sequence}]`,
          code: 'INVALID_ICD10',
          message: `Invalid ICD-10 format: ${dx.code}`,
          severity: 'error',
        });
      }
    }

    // Resubmission validation
    if (input.isResubmission && !input.originalClaimId) {
      errors.push({
        field: 'originalClaimId',
        code: 'MISSING_ORIGINAL_CLAIM',
        message: 'Original claim ID is required for resubmissions',
        severity: 'error',
      });
    }

    // Calculate total charge
    ctx.state.totalCharge = input.serviceLines.reduce(
      (sum, line) => sum + (line.chargeAmount * line.units),
      0
    );

    // Sanity check on total - flag unusually high claims
    if (ctx.state.totalCharge > 50000_00) { // $50,000
      warnings.push({
        field: 'totalCharge',
        code: 'HIGH_CHARGE_AMOUNT',
        message: `Total charge of $${Money.format(ctx.state.totalCharge)} exceeds threshold`,
        severity: 'warning',
      });
    }

    ctx.state.validationResult = {
      valid: errors.length === 0,
      errors,
      warnings,
    };

    if (errors.length > 0) {
      logger.warn('Claim validation failed', {
        action: 'CLAIM_VALIDATION_FAILED',
        claimId: input.claimId,
        errorCount: errors.length,
        warningCount: warnings.length,
      });

      throw new ValidationError(
        `Claim validation failed with ${errors.length} error(s)`,
        errors.map(e => e.message)
      );
    }

    logger.info('Claim validation passed', {
      action: 'CLAIM_VALIDATION_PASSED',
      claimId: input.claimId,
      warningCount: warnings.length,
      totalCharge: ctx.state.totalCharge,
    });
  },
};

// --- Step 2: Check Eligibility -----------------------------------------------

const checkEligibilityStep: WorkflowStep<ClaimSubmissionState> = {
  name: 'check_eligibility',
  timeout: 30000,
  retries: 2,
  retryDelay: 5000,

  async execute(ctx: WorkflowContext<ClaimSubmissionState>): Promise<void> {
    ctx.state.status = 'checking_eligibility';
    const { input } = ctx.state;

    const eligibilityClient = new EligibilityClient({ preferRealTime: true });

    try {
      const result = await eligibilityClient.checkEligibility({
        memberId: input.subscriberId,
        payerId: input.payerId,
        serviceDate: input.serviceLines[0].serviceDate,
        serviceType: mapClaimTypeToServiceType(input.claimType),
        npi: input.providerId,
      });

      ctx.state.eligibilityConfirmed = result.eligible;

      if (!result.eligible) {
        // Don't block submission - some claims are submitted knowing they'll
        // be denied (e.g., to start the appeals process for out-of-network)
        logger.warn('Patient not eligible at time of claim submission', {
          action: 'ELIGIBILITY_NOT_CONFIRMED',
          claimId: input.claimId,
          payerId: input.payerId,
        });
      }
    } catch (error: any) {
      // Eligibility check failure should not block claim submission
      // The clearinghouse will reject if truly ineligible
      logger.warn('Eligibility check failed, proceeding with submission', {
        action: 'ELIGIBILITY_CHECK_ERROR',
        claimId: input.claimId,
        error: error.message,
      });
      ctx.state.eligibilityConfirmed = false;
    }
  },
};

function mapClaimTypeToServiceType(claimType: '837P' | '837I'): string {
  // X12 service type codes
  return claimType === '837P' ? '30' : '48'; // Professional vs Inpatient
}

// --- Step 3: Scrub for Errors ------------------------------------------------

const scrubClaimStep: WorkflowStep<ClaimSubmissionState> = {
  name: 'scrub_claim',
  timeout: 15000,
  retries: 1,

  async execute(ctx: WorkflowContext<ClaimSubmissionState>): Promise<void> {
    ctx.state.status = 'scrubbing';
    const { input } = ctx.state;

    logger.info('Scrubbing claim for errors', {
      action: 'CLAIM_SCRUB_START',
      claimId: input.claimId,
    });

    const issues: ScrubIssue[] = [];
    const autoFixed: ScrubIssue[] = [];

    // Payer-specific rules
    // TODO: These rules are hardcoded. We need to move them to a rules engine
    // that the billing team can manage without code changes. This has been on
    // the roadmap since Q2 2025 but keeps getting deprioritized.

    // Medicare-specific rules
    if (input.payerId.startsWith('CMS')) {
      // Check for required modifiers
      for (const line of input.serviceLines) {
        // Telehealth services need modifier 95
        if (line.placeOfService === '02' && !line.modifiers.includes('95')) {
          issues.push({
            lineNumber: line.lineNumber,
            ruleId: 'CMS-TELEHEALTH-MOD',
            description: 'Telehealth service requires modifier 95 for Medicare',
            category: 'payer_specific',
            autoFixable: true,
          });
          // Auto-fix: add the modifier
          line.modifiers.push('95');
          autoFixed.push({
            lineNumber: line.lineNumber,
            ruleId: 'CMS-TELEHEALTH-MOD',
            description: 'Added modifier 95 for telehealth service',
            category: 'payer_specific',
            autoFixable: true,
          });
        }
      }
    }

    // NCCI edit checks (simplified - real implementation would use CCI tables)
    const procedureCodes = input.serviceLines.map(l => l.procedureCode);
    const duplicateCodes = procedureCodes.filter(
      (code, idx) => procedureCodes.indexOf(code) !== idx
    );

    if (duplicateCodes.length > 0) {
      for (const code of [...new Set(duplicateCodes)]) {
        issues.push({
          ruleId: 'NCCI-DUPLICATE',
          description: `Duplicate procedure code ${code} - verify units vs separate lines`,
          category: 'coding',
          autoFixable: false,
        });
      }
    }

    // Check that primary diagnosis is not a Z-code for certain service types
    const primaryDx = input.diagnosisCodes.find(d => d.sequence === 1);
    if (primaryDx && primaryDx.code.startsWith('Z') && input.claimType === '837I') {
      issues.push({
        ruleId: 'DX-PRIMARY-ZCODE',
        description: 'Z-code as primary diagnosis may be rejected for institutional claims',
        category: 'coding',
        autoFixable: false,
      });
    }

    // Timely filing check
    const oldestServiceDate = input.serviceLines
      .map(l => new Date(l.serviceDate).getTime())
      .sort()[0];
    const daysSinceService = Math.floor(
      (Date.now() - oldestServiceDate) / (1000 * 60 * 60 * 24)
    );

    // Most payers have a 90-365 day timely filing limit
    // We warn at 60 days because some payers are at 90
    if (daysSinceService > 60) {
      issues.push({
        ruleId: 'TIMELY-FILING-WARN',
        description: `Service date is ${daysSinceService} days ago - check payer timely filing limit`,
        category: 'billing',
        autoFixable: false,
      });
    }

    if (daysSinceService > 365) {
      issues.push({
        ruleId: 'TIMELY-FILING-EXPIRED',
        description: `Service date is ${daysSinceService} days ago - likely past all payer timely filing limits`,
        category: 'billing',
        autoFixable: false,
      });
    }

    ctx.state.scrubResult = {
      clean: issues.filter(i => !i.autoFixable).length === 0,
      issues,
      autoFixed,
    };

    const nonAutoFixable = issues.filter(i => !i.autoFixable);
    if (nonAutoFixable.length > 0) {
      logger.warn('Claim scrub found issues', {
        action: 'CLAIM_SCRUB_ISSUES',
        claimId: input.claimId,
        issueCount: nonAutoFixable.length,
        autoFixedCount: autoFixed.length,
      });

      // We don't throw on scrub issues - they're warnings
      // The billing team reviews the scrub report before final submission
    }
  },
};

// --- Step 4: Submit to Clearinghouse -----------------------------------------

const submitToClearinghouseStep: WorkflowStep<ClaimSubmissionState> = {
  name: 'submit_to_clearinghouse',
  timeout: 60000,
  retries: 3,
  retryDelay: 10000,

  async execute(ctx: WorkflowContext<ClaimSubmissionState>): Promise<void> {
    ctx.state.status = 'submitting';
    const { input } = ctx.state;

    const primaryClearinghouse = new ClearinghouseClient({
      provider: 'change_healthcare',
      apiKey: process.env.CHANGE_HEALTHCARE_API_KEY!,
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
    });

    logger.info('Submitting claim to clearinghouse', {
      action: 'CLAIM_SUBMIT_START',
      claimId: input.claimId,
      clearinghouse: 'change_healthcare',
    });

    try {
      const result = await primaryClearinghouse.submitClaim({
        claimType: input.claimType,
        patientId: input.patientId,
        subscriberId: input.subscriberId,
        payerId: input.payerId,
        providerId: input.providerId,
        facilityId: input.facilityId,
        serviceLines: input.serviceLines,
        diagnosisCodes: input.diagnosisCodes,
        priorAuthNumber: input.priorAuthNumber,
        isResubmission: input.isResubmission,
        originalClaimId: input.originalClaimId,
      });

      ctx.state.submissionResult = result;
      ctx.state.trackingNumber = result.trackingNumber;
      ctx.state.clearinghouseUsed = 'change_healthcare';
      ctx.state.status = result.accepted ? 'accepted' : 'rejected';

      logger.info('Claim submitted to clearinghouse', {
        action: 'CLAIM_SUBMITTED',
        claimId: input.claimId,
        trackingNumber: result.trackingNumber,
        accepted: result.accepted,
      });
    } catch (error: any) {
      ctx.state.retryCount++;

      // After 2 failed attempts with Change Healthcare, try Availity as fallback
      // This fallback was added after the Change Healthcare outage in Feb 2024
      // where we couldn't submit claims for 3 days.
      if (ctx.state.retryCount >= 2) {
        logger.warn('Primary clearinghouse failed, trying Availity fallback', {
          action: 'CLEARINGHOUSE_FALLBACK',
          claimId: input.claimId,
          primaryError: error.message,
          retryCount: ctx.state.retryCount,
        });

        try {
          const fallbackClearinghouse = new ClearinghouseClient({
            provider: 'availity',
            apiKey: process.env.AVAILITY_API_KEY!,
            environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
          });

          const result = await fallbackClearinghouse.submitClaim({
            claimType: input.claimType,
            patientId: input.patientId,
            subscriberId: input.subscriberId,
            payerId: input.payerId,
            providerId: input.providerId,
            facilityId: input.facilityId,
            serviceLines: input.serviceLines,
            diagnosisCodes: input.diagnosisCodes,
            priorAuthNumber: input.priorAuthNumber,
            isResubmission: input.isResubmission,
            originalClaimId: input.originalClaimId,
          });

          ctx.state.submissionResult = result;
          ctx.state.trackingNumber = result.trackingNumber;
          ctx.state.clearinghouseUsed = 'availity';
          ctx.state.status = result.accepted ? 'accepted' : 'rejected';

          logger.info('Claim submitted via fallback clearinghouse', {
            action: 'CLAIM_SUBMITTED_FALLBACK',
            claimId: input.claimId,
            trackingNumber: result.trackingNumber,
          });

          return;
        } catch (fallbackError: any) {
          logger.error('Fallback clearinghouse also failed', {
            action: 'CLEARINGHOUSE_FALLBACK_FAILED',
            claimId: input.claimId,
            error: fallbackError.message,
          });
        }
      }

      ctx.state.errors.push({
        step: 'submit_to_clearinghouse',
        error: error.message,
        timestamp: new Date().toISOString(),
        retryable: true,
      });

      throw error; // Let the retry logic handle it
    }
  },
};

// --- Step 5: Track Status ----------------------------------------------------

const trackStatusStep: WorkflowStep<ClaimSubmissionState> = {
  name: 'track_status',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<ClaimSubmissionState>): Promise<void> {
    const { input } = ctx.state;

    if (!ctx.state.trackingNumber) {
      logger.warn('No tracking number available, skipping status tracking setup', {
        action: 'TRACK_SKIP',
        claimId: input.claimId,
      });
      return;
    }

    const claimService = new ClaimService();

    // Update the claim record with submission details
    await claimService.updateClaim(input.claimId, {
      status: ctx.state.status,
      trackingNumber: ctx.state.trackingNumber,
      clearinghouse: ctx.state.clearinghouseUsed,
      totalCharge: ctx.state.totalCharge,
      submittedAt: new Date().toISOString(),
      submittedBy: input.submittedBy,
      scrubIssues: ctx.state.scrubResult?.issues.length || 0,
    });

    // Publish domain event for downstream consumers
    const eventBus = new EventBus();
    await eventBus.publish('claim.submitted', {
      claimId: input.claimId,
      trackingNumber: ctx.state.trackingNumber,
      payerId: input.payerId,
      totalCharge: ctx.state.totalCharge,
      clearinghouse: ctx.state.clearinghouseUsed,
      timestamp: new Date().toISOString(),
    });

    // Schedule a status check for 24 hours from now
    // The clearinghouse usually sends a 277CA (acknowledgment) within 24h
    await ctx.scheduleEvent('check_claim_status', {
      scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      data: {
        claimId: input.claimId,
        trackingNumber: ctx.state.trackingNumber,
        clearinghouse: ctx.state.clearinghouseUsed,
      },
    });

    logger.info('Claim tracking initialized', {
      action: 'CLAIM_TRACKING_STARTED',
      claimId: input.claimId,
      trackingNumber: ctx.state.trackingNumber,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const submitClaimWorkflow = new WorkflowEngine<ClaimSubmissionInput, ClaimSubmissionState>({
  name: 'submit_claim',
  version: '4.2.0',
  description: 'Validates and submits healthcare claims through clearinghouse',

  initialState: (input: ClaimSubmissionInput): ClaimSubmissionState => ({
    input,
    eligibilityConfirmed: false,
    status: 'validating',
    retryCount: 0,
    errors: [],
    totalCharge: 0,
  }),

  steps: [
    validateClaimStep,
    checkEligibilityStep,
    scrubClaimStep,
    submitToClearinghouseStep,
    trackStatusStep,
  ],

  criticalSteps: ['validate_claim', 'submit_to_clearinghouse'],
  bestEffortSteps: ['check_eligibility', 'track_status'],

  hooks: {
    onComplete: async (ctx) => {
      logger.info('Claim submission workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        claimId: ctx.state.input.claimId,
        status: ctx.state.status,
        trackingNumber: ctx.state.trackingNumber,
        clearinghouse: ctx.state.clearinghouseUsed,
        totalCharge: ctx.state.totalCharge,
        duration: ctx.duration,
      });
    },

    onError: async (ctx, error) => {
      ctx.state.status = 'failed';

      logger.error('Claim submission workflow failed', {
        action: 'WORKFLOW_FAILED',
        claimId: ctx.state.input.claimId,
        step: ctx.currentStep,
        error: error.message,
        retryCount: ctx.state.retryCount,
      });

      // Update claim status to failed
      const claimService = new ClaimService();
      await claimService.updateClaim(ctx.state.input.claimId, {
        status: 'submission_failed',
        failureReason: error.message,
      });
    },
  },
});

export type { ClaimSubmissionInput, ClaimSubmissionState };
