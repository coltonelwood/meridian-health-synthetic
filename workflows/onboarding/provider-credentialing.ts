/**
 * Provider Credentialing Workflow
 *
 * Manages the end-to-end credentialing process for healthcare providers.
 * This is one of the longest-running workflows in the system - a typical
 * credentialing process takes 60-120 days. The workflow uses durable
 * execution with checkpointing so it survives service restarts.
 *
 * Manual steps are modeled as "wait for human" steps that pause the
 * workflow until an authorized user advances it.
 *
 * Owner: Provider Operations team
 * Compliance: NCQA credentialing standards, state-specific requirements
 *
 * WARNING: Do not refactor the step ordering without consulting the
 * compliance team. The sequence matters for audit trail purposes.
 */

import { DurableWorkflow, WorkflowStep, HumanStep, WorkflowContext } from '@meridian/workflow-engine';
import { NPIRegistry, NPIRecord } from '@meridian/npi-client';
import { LicenseVerificationService, LicenseRecord } from '@meridian/license-verification';
import { BackgroundCheckService, BackgroundCheckResult } from '@meridian/background-check-client';
import { ProviderService, ProviderRecord } from '@meridian/provider-service-client';
import { NotificationService } from '@meridian/notification-service';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { AppError } from '@meridian/shared-utils';
import { EventBus } from '@meridian/event-bus';

const logger = new HIPAALogger({ service: 'provider-credentialing-workflow' });

// --- Types -------------------------------------------------------------------

interface CredentialingInput {
  providerId: string;
  npi: string;
  licenseNumber: string;
  licenseState: string;
  specialtyCode: string;
  requestedPrivileges: string[];
  organizationId: string;
  requestedBy: string;
  priority: 'standard' | 'expedited'; // expedited for locum tenens, costs more
}

interface CredentialingState {
  input: CredentialingInput;
  applicationReceivedDate: string;
  npiVerification?: NPIVerificationResult;
  licenseVerification?: LicenseVerificationResult;
  backgroundCheck?: BackgroundCheckStatus;
  committeeReview?: CommitteeReviewResult;
  decision?: CredentialingDecision;
  currentPhase: CredentialingPhase;
  statusHistory: StatusEntry[];
  expirationDate?: string;
  notes: string[];
}

type CredentialingPhase =
  | 'application_received'
  | 'primary_source_verification'
  | 'npi_verification'
  | 'license_verification'
  | 'background_check_pending'
  | 'background_check_complete'
  | 'committee_review_pending'
  | 'committee_review_complete'
  | 'decision_pending'
  | 'approved'
  | 'denied'
  | 'withdrawn'
  | 'expired';

interface NPIVerificationResult {
  valid: boolean;
  npiRecord: NPIRecord;
  matchesApplication: boolean;
  discrepancies: string[];
  verifiedAt: string;
}

interface LicenseVerificationResult {
  valid: boolean;
  licenseRecord: LicenseRecord;
  expirationDate: string;
  disciplinaryActions: DisciplinaryAction[];
  verifiedAt: string;
}

interface DisciplinaryAction {
  date: string;
  type: string;
  description: string;
  status: 'active' | 'resolved';
}

interface BackgroundCheckStatus {
  requestId: string;
  status: 'pending' | 'complete' | 'failed';
  result?: BackgroundCheckResult;
  completedAt?: string;
}

interface CommitteeReviewResult {
  reviewDate: string;
  reviewers: string[];
  recommendation: 'approve' | 'deny' | 'defer' | 'approve_with_conditions';
  conditions?: string[];
  comments: string;
}

interface CredentialingDecision {
  decision: 'approved' | 'denied' | 'approved_with_conditions';
  effectiveDate: string;
  expirationDate: string;
  privileges: string[];
  conditions?: string[];
  decidedBy: string;
  decidedAt: string;
}

interface StatusEntry {
  phase: CredentialingPhase;
  timestamp: string;
  actor: string;
  notes?: string;
}

// --- Helpers -----------------------------------------------------------------

function updatePhase(
  ctx: WorkflowContext<CredentialingState>,
  phase: CredentialingPhase,
  actor: string,
  notes?: string
): void {
  ctx.state.currentPhase = phase;
  ctx.state.statusHistory.push({
    phase,
    timestamp: new Date().toISOString(),
    actor,
    notes,
  });
}

// --- Step 1: NPI Verification ------------------------------------------------

const verifyNPIStep: WorkflowStep<CredentialingState> = {
  name: 'verify_npi',
  timeout: 30000,
  retries: 3,
  retryDelay: 5000,

  async execute(ctx: WorkflowContext<CredentialingState>): Promise<void> {
    updatePhase(ctx, 'npi_verification', 'system');

    const npiRegistry = new NPIRegistry();
    const { npi, licenseState, specialtyCode } = ctx.state.input;

    logger.info('Verifying provider NPI', {
      action: 'NPI_VERIFICATION_START',
      providerId: ctx.state.input.providerId,
      npi,
    });

    const npiRecord = await npiRegistry.lookup(npi);

    if (!npiRecord) {
      ctx.state.npiVerification = {
        valid: false,
        npiRecord: null as any,
        matchesApplication: false,
        discrepancies: ['NPI not found in NPPES registry'],
        verifiedAt: new Date().toISOString(),
      };

      ctx.state.notes.push(`NPI ${npi} not found in NPPES registry`);

      // NPI not found is a hard stop - can't proceed
      throw new AppError(`NPI ${npi} not found in NPPES registry`, 'NPI_NOT_FOUND');
    }

    // Cross-reference the NPI record with the application
    const discrepancies: string[] = [];

    if (npiRecord.status !== 'active') {
      discrepancies.push(`NPI status is ${npiRecord.status}, expected active`);
    }

    // Check if the NPI is the right type (Type 1 = individual, Type 2 = organization)
    if (npiRecord.entityType !== '1') {
      discrepancies.push('NPI is not an individual provider (Type 1)');
    }

    // Verify state matches
    if (npiRecord.practiceState !== licenseState) {
      discrepancies.push(
        `Practice state mismatch: application says ${licenseState}, NPI says ${npiRecord.practiceState}`
      );
    }

    // Check taxonomy code matches specialty
    // TODO: This is a loose check. We should build a proper taxonomy-to-specialty
    // mapping table. Right now we're just checking the first 3 chars match, which
    // misses some edge cases with subspecialties.
    const taxonomyMatch = npiRecord.taxonomyCodes?.some(
      (t: string) => t.startsWith(specialtyCode.substring(0, 3))
    );
    if (!taxonomyMatch) {
      discrepancies.push('Taxonomy code does not match declared specialty');
    }

    ctx.state.npiVerification = {
      valid: npiRecord.status === 'active' && discrepancies.length === 0,
      npiRecord,
      matchesApplication: discrepancies.length === 0,
      discrepancies,
      verifiedAt: new Date().toISOString(),
    };

    if (discrepancies.length > 0) {
      logger.warn('NPI verification found discrepancies', {
        action: 'NPI_DISCREPANCIES',
        providerId: ctx.state.input.providerId,
        discrepancyCount: discrepancies.length,
      });
    }

    logger.info('NPI verification complete', {
      action: 'NPI_VERIFICATION_COMPLETE',
      providerId: ctx.state.input.providerId,
      valid: ctx.state.npiVerification.valid,
    });
  },
};

// --- Step 2: License Verification --------------------------------------------

const verifyLicenseStep: WorkflowStep<CredentialingState> = {
  name: 'verify_license',
  timeout: 60000, // state boards can be slow
  retries: 3,
  retryDelay: 10000,

  async execute(ctx: WorkflowContext<CredentialingState>): Promise<void> {
    updatePhase(ctx, 'license_verification', 'system');

    const licenseService = new LicenseVerificationService();
    const { licenseNumber, licenseState } = ctx.state.input;

    logger.info('Verifying provider license', {
      action: 'LICENSE_VERIFICATION_START',
      providerId: ctx.state.input.providerId,
      state: licenseState,
    });

    // Primary source verification - we go directly to the state board
    const licenseRecord = await licenseService.verifyWithStateBoard({
      licenseNumber,
      state: licenseState,
    });

    const disciplinaryActions = await licenseService.checkDisciplinaryActions({
      licenseNumber,
      state: licenseState,
    });

    // Also check the NPDB (National Practitioner Data Bank)
    // This is technically a separate step in some credentialing standards,
    // but we bundle it here for efficiency.
    // TODO: NPDB queries cost money ($2/query as of 2025). We should track
    // spending and potentially batch these. Currently we're doing ~200/month.
    const npdbResult = await licenseService.queryNPDB({
      firstName: ctx.state.npiVerification?.npiRecord?.firstName,
      lastName: ctx.state.npiVerification?.npiRecord?.lastName,
      npi: ctx.state.input.npi,
      state: licenseState,
    });

    const allDisciplinaryActions: DisciplinaryAction[] = [
      ...disciplinaryActions.map((d: any) => ({
        date: d.actionDate,
        type: d.actionType,
        description: d.description,
        status: d.isResolved ? 'resolved' as const : 'active' as const,
      })),
      ...(npdbResult.reports || []).map((r: any) => ({
        date: r.reportDate,
        type: 'NPDB_REPORT',
        description: r.description,
        status: 'active' as const,
      })),
    ];

    ctx.state.licenseVerification = {
      valid: licenseRecord.status === 'active' && !licenseRecord.isRestricted,
      licenseRecord,
      expirationDate: licenseRecord.expirationDate,
      disciplinaryActions: allDisciplinaryActions,
      verifiedAt: new Date().toISOString(),
    };

    // If there are active disciplinary actions, flag for committee review
    const activeDisciplinary = allDisciplinaryActions.filter(d => d.status === 'active');
    if (activeDisciplinary.length > 0) {
      ctx.state.notes.push(
        `WARNING: ${activeDisciplinary.length} active disciplinary action(s) found. ` +
        `Requires committee attention.`
      );
    }

    // Check license expiration - if expiring within 90 days, note it
    const daysUntilExpiration = Math.floor(
      (new Date(licenseRecord.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    if (daysUntilExpiration < 90) {
      ctx.state.notes.push(
        `License expires in ${daysUntilExpiration} days (${licenseRecord.expirationDate}). ` +
        `Provider will need to renew before credentialing period ends.`
      );
    }

    logger.info('License verification complete', {
      action: 'LICENSE_VERIFICATION_COMPLETE',
      providerId: ctx.state.input.providerId,
      valid: ctx.state.licenseVerification.valid,
      disciplinaryCount: allDisciplinaryActions.length,
    });
  },
};

// --- Step 3: Background Check ------------------------------------------------

const initiateBackgroundCheckStep: WorkflowStep<CredentialingState> = {
  name: 'initiate_background_check',
  timeout: 15000,
  retries: 2,

  async execute(ctx: WorkflowContext<CredentialingState>): Promise<void> {
    updatePhase(ctx, 'background_check_pending', 'system');

    const bgCheckService = new BackgroundCheckService();

    // Background checks are initiated asynchronously - they typically take
    // 3-7 business days to complete. We start the check and then the
    // workflow waits for a callback.
    const requestId = await bgCheckService.initiateCheck({
      providerId: ctx.state.input.providerId,
      npi: ctx.state.input.npi,
      checkTypes: [
        'criminal_history',
        'sanctions_check', // OIG/SAM exclusion lists
        'dea_verification',
        'education_verification',
        'work_history',
      ],
      // Expedited checks cost more but come back in 1-2 days
      expedited: ctx.state.input.priority === 'expedited',
      callbackUrl: `https://api.meridianhealth.io/webhooks/credentialing/bg-check/${ctx.workflowId}`,
    });

    ctx.state.backgroundCheck = {
      requestId,
      status: 'pending',
    };

    logger.info('Background check initiated', {
      action: 'BACKGROUND_CHECK_INITIATED',
      providerId: ctx.state.input.providerId,
      requestId,
      expedited: ctx.state.input.priority === 'expedited',
    });

    // The workflow will now pause and wait for the callback
    // See: waitForBackgroundCheckStep below
  },
};

// This is a "wait" step - the workflow engine pauses here until an
// external event (webhook callback) advances it.
const waitForBackgroundCheckStep: WorkflowStep<CredentialingState> = {
  name: 'wait_for_background_check',
  // 30 days timeout - if we don't hear back, escalate
  timeout: 30 * 24 * 60 * 60 * 1000,
  retries: 0,

  async execute(ctx: WorkflowContext<CredentialingState>): Promise<void> {
    // This step is resolved by the webhook handler calling:
    // workflowEngine.resolveWaitStep(workflowId, 'wait_for_background_check', result)
    //
    // The webhook handler is in:
    // services/credentialing-api/src/webhooks/background-check.ts

    await ctx.waitForExternalEvent('background_check_complete', {
      timeoutAction: async () => {
        // If we haven't heard back in 30 days, notify the credentialing team
        const notificationService = new NotificationService();
        await notificationService.send({
          recipientId: ctx.state.input.requestedBy,
          channel: 'email',
          template: 'bg_check_timeout',
          data: {
            providerId: ctx.state.input.providerId,
            requestId: ctx.state.backgroundCheck?.requestId,
            daysPending: 30,
          },
          priority: 'high',
        });
      },
    });

    // Once resolved, the background check result will be in ctx.eventData
    const result = ctx.eventData as BackgroundCheckResult;

    ctx.state.backgroundCheck = {
      requestId: ctx.state.backgroundCheck!.requestId,
      status: 'complete',
      result,
      completedAt: new Date().toISOString(),
    };

    updatePhase(ctx, 'background_check_complete', 'system');

    if (result.flagged) {
      ctx.state.notes.push(
        `Background check flagged: ${result.flags.join(', ')}. Requires committee review.`
      );
    }

    logger.info('Background check complete', {
      action: 'BACKGROUND_CHECK_COMPLETE',
      providerId: ctx.state.input.providerId,
      flagged: result.flagged,
    });
  },
};

// --- Step 4: Committee Review (Manual Step) -----------------------------------

/**
 * This is a manual step - a human must review the credentialing file
 * and make a recommendation. The workflow pauses here until a credentialing
 * committee member submits their review through the admin UI.
 *
 * The admin UI calls:
 * POST /api/credentialing/{workflowId}/committee-review
 * { recommendation: 'approve', comments: '...', reviewers: [...] }
 *
 * Which calls workflowEngine.resolveHumanStep(workflowId, 'committee_review', data)
 */
const committeeReviewStep: HumanStep<CredentialingState> = {
  name: 'committee_review',
  type: 'human',
  // 60 days for committee review - they meet monthly
  timeout: 60 * 24 * 60 * 60 * 1000,

  assignTo: async (ctx): Promise<string[]> => {
    // Assign to credentialing committee members for the org
    // In practice this is a role-based assignment
    return ['role:credentialing_committee', `org:${ctx.state.input.organizationId}`];
  },

  // Validate the human input before accepting it
  validateInput: async (ctx, input: CommitteeReviewResult): Promise<string | null> => {
    if (!input.recommendation) {
      return 'Recommendation is required';
    }
    if (!['approve', 'deny', 'defer', 'approve_with_conditions'].includes(input.recommendation)) {
      return 'Invalid recommendation value';
    }
    if (input.recommendation === 'approve_with_conditions' && !input.conditions?.length) {
      return 'Conditions are required when approving with conditions';
    }
    if (!input.comments || input.comments.length < 10) {
      return 'Comments are required (minimum 10 characters)';
    }
    if (!input.reviewers || input.reviewers.length < 2) {
      // NCQA requires at least 2 peer reviewers
      return 'At least 2 reviewers are required per NCQA standards';
    }
    return null; // valid
  },

  async execute(ctx: WorkflowContext<CredentialingState>): Promise<void> {
    updatePhase(ctx, 'committee_review_pending', 'system');

    // Send notification to committee members that a review is pending
    const notificationService = new NotificationService();
    await notificationService.send({
      recipientId: 'role:credentialing_committee',
      channel: 'email',
      template: 'committee_review_needed',
      data: {
        providerId: ctx.state.input.providerId,
        npi: ctx.state.input.npi,
        specialty: ctx.state.input.specialtyCode,
        hasFlags: (ctx.state.backgroundCheck?.result?.flagged || false) ||
                  (ctx.state.licenseVerification?.disciplinaryActions?.filter(
                    d => d.status === 'active'
                  ).length || 0) > 0,
        notes: ctx.state.notes,
      },
      priority: 'normal',
    });

    // Wait for human input
    await ctx.waitForHumanInput();

    // Human input is now available
    const review = ctx.humanInput as CommitteeReviewResult;

    ctx.state.committeeReview = {
      reviewDate: new Date().toISOString(),
      reviewers: review.reviewers,
      recommendation: review.recommendation,
      conditions: review.conditions,
      comments: review.comments,
    };

    updatePhase(ctx, 'committee_review_complete', ctx.userId);

    logger.audit('Committee review submitted', {
      action: 'CREDENTIALING_REVIEW',
      providerId: ctx.state.input.providerId,
      recommendation: review.recommendation,
      reviewerCount: review.reviewers.length,
      userId: ctx.userId,
    });

    // If deferred, the workflow loops back for more information
    if (review.recommendation === 'defer') {
      ctx.state.notes.push(`Committee deferred: ${review.comments}`);
      // In a real implementation, we'd loop back to gather more info
      // For now, we just note it and continue to decision
    }
  },
};

// --- Step 5: Credentialing Decision ------------------------------------------

const credentialingDecisionStep: WorkflowStep<CredentialingState> = {
  name: 'credentialing_decision',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<CredentialingState>): Promise<void> {
    updatePhase(ctx, 'decision_pending', 'system');

    if (!ctx.state.committeeReview) {
      throw new AppError('Cannot make decision without committee review');
    }

    const recommendation = ctx.state.committeeReview.recommendation;
    const providerService = new ProviderService();
    const eventBus = new EventBus();

    if (recommendation === 'deny') {
      ctx.state.decision = {
        decision: 'denied',
        effectiveDate: new Date().toISOString(),
        expirationDate: new Date().toISOString(), // N/A for denials
        privileges: [],
        decidedBy: ctx.state.committeeReview.reviewers[0],
        decidedAt: new Date().toISOString(),
      };

      updatePhase(ctx, 'denied', 'system');

      await providerService.updateCredentialingStatus(ctx.state.input.providerId, {
        status: 'denied',
        reason: ctx.state.committeeReview.comments,
      });

      await eventBus.publish('provider.credentialing.denied', {
        providerId: ctx.state.input.providerId,
        npi: ctx.state.input.npi,
        reason: ctx.state.committeeReview.comments,
      });
    } else {
      // Approved or approved with conditions
      // Credentialing is valid for 2 years per NCQA standards
      // TODO: Some payers require 3-year cycles. We should make this
      // configurable per organization/payer.
      const effectiveDate = new Date();
      const expirationDate = new Date(effectiveDate);
      expirationDate.setFullYear(expirationDate.getFullYear() + 2);

      ctx.state.decision = {
        decision: recommendation === 'approve_with_conditions'
          ? 'approved_with_conditions'
          : 'approved',
        effectiveDate: effectiveDate.toISOString(),
        expirationDate: expirationDate.toISOString(),
        privileges: ctx.state.input.requestedPrivileges,
        conditions: ctx.state.committeeReview.conditions,
        decidedBy: ctx.state.committeeReview.reviewers[0],
        decidedAt: new Date().toISOString(),
      };

      ctx.state.expirationDate = expirationDate.toISOString();

      updatePhase(ctx, 'approved', 'system');

      await providerService.updateCredentialingStatus(ctx.state.input.providerId, {
        status: 'active',
        effectiveDate: effectiveDate.toISOString(),
        expirationDate: expirationDate.toISOString(),
        privileges: ctx.state.input.requestedPrivileges,
        conditions: ctx.state.committeeReview.conditions,
      });

      await eventBus.publish('provider.credentialing.approved', {
        providerId: ctx.state.input.providerId,
        npi: ctx.state.input.npi,
        effectiveDate: effectiveDate.toISOString(),
        expirationDate: expirationDate.toISOString(),
      });

      // Schedule re-credentialing reminder 90 days before expiration
      const reminderDate = new Date(expirationDate);
      reminderDate.setDate(reminderDate.getDate() - 90);

      await ctx.scheduleEvent('credentialing_renewal_reminder', {
        scheduledFor: reminderDate.toISOString(),
        data: {
          providerId: ctx.state.input.providerId,
          npi: ctx.state.input.npi,
          expirationDate: expirationDate.toISOString(),
        },
      });
    }

    // Notify the provider and the requesting user
    const notificationService = new NotificationService();

    await notificationService.send({
      recipientId: ctx.state.input.requestedBy,
      channel: 'email',
      template: recommendation === 'deny'
        ? 'credentialing_denied'
        : 'credentialing_approved',
      data: {
        providerId: ctx.state.input.providerId,
        decision: ctx.state.decision?.decision,
        effectiveDate: ctx.state.decision?.effectiveDate,
        expirationDate: ctx.state.decision?.expirationDate,
        conditions: ctx.state.decision?.conditions,
      },
      priority: 'high',
    });

    logger.audit('Credentialing decision made', {
      action: 'CREDENTIALING_DECISION',
      providerId: ctx.state.input.providerId,
      decision: ctx.state.decision?.decision,
      userId: ctx.state.decision?.decidedBy,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const providerCredentialingWorkflow = new DurableWorkflow<
  CredentialingInput,
  CredentialingState
>({
  name: 'provider_credentialing',
  version: '3.1.0',
  description: 'End-to-end provider credentialing process (60-120 day duration)',

  // This workflow can run for months - it needs durable execution
  durability: {
    checkpointAfterEachStep: true,
    persistState: true,
    surviveServiceRestart: true,
  },

  initialState: (input: CredentialingInput): CredentialingState => ({
    input,
    applicationReceivedDate: new Date().toISOString(),
    currentPhase: 'application_received',
    statusHistory: [{
      phase: 'application_received',
      timestamp: new Date().toISOString(),
      actor: input.requestedBy,
    }],
    notes: [],
  }),

  steps: [
    verifyNPIStep,
    verifyLicenseStep,
    initiateBackgroundCheckStep,
    waitForBackgroundCheckStep,
    committeeReviewStep,
    credentialingDecisionStep,
  ],

  // All steps are critical in credentialing
  criticalSteps: [
    'verify_npi',
    'verify_license',
    'initiate_background_check',
    'wait_for_background_check',
    'committee_review',
    'credentialing_decision',
  ],

  hooks: {
    onComplete: async (ctx) => {
      const durationDays = Math.floor(
        (Date.now() - new Date(ctx.state.applicationReceivedDate).getTime()) /
        (1000 * 60 * 60 * 24)
      );

      logger.info('Provider credentialing workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        providerId: ctx.state.input.providerId,
        decision: ctx.state.decision?.decision,
        durationDays,
        phases: ctx.state.statusHistory.length,
      });
    },

    onError: async (ctx, error) => {
      logger.error('Provider credentialing workflow failed', {
        action: 'WORKFLOW_FAILED',
        providerId: ctx.state.input.providerId,
        phase: ctx.state.currentPhase,
        error: error.message,
      });

      // Credentialing failures always require human attention
      const notificationService = new NotificationService();
      await notificationService.send({
        recipientId: ctx.state.input.requestedBy,
        channel: 'email',
        template: 'credentialing_workflow_error',
        data: {
          providerId: ctx.state.input.providerId,
          phase: ctx.state.currentPhase,
          error: error.message,
        },
        priority: 'urgent',
      });
    },

    // Periodic check - runs daily while workflow is active
    onHeartbeat: async (ctx) => {
      const daysInCurrentPhase = Math.floor(
        (Date.now() - new Date(
          ctx.state.statusHistory[ctx.state.statusHistory.length - 1].timestamp
        ).getTime()) / (1000 * 60 * 60 * 24)
      );

      // If stuck in any phase for more than 14 days, escalate
      if (daysInCurrentPhase > 14) {
        logger.warn('Credentialing workflow stuck in phase', {
          action: 'WORKFLOW_STUCK',
          providerId: ctx.state.input.providerId,
          phase: ctx.state.currentPhase,
          daysInPhase: daysInCurrentPhase,
        });
      }
    },
  },
});

export type { CredentialingInput, CredentialingState, CredentialingDecision };
