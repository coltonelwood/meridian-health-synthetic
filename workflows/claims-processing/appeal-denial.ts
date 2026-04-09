/**
 * Denial Appeal Workflow
 *
 * Manages the process of appealing denied claims. Currently partially
 * automated - letter generation and document attachment are automated,
 * but a human reviewer approves the appeal before submission.
 *
 * The auto-appeal path (for common denial reasons) bypasses the human
 * review step if the denial matches certain criteria and the claim was
 * a high-confidence match from the remittance processor.
 *
 * Owner: Revenue Cycle team
 * Success rate: ~42% of appeals result in overturned denials (as of Q1 2026)
 *
 * TODO: ML model for predicting appeal success is in development (data-science
 * team, ETA Q3 2026). Would allow us to prioritize high-value appeals.
 */

import { WorkflowEngine, WorkflowStep, HumanStep, WorkflowContext } from '@meridian/workflow-engine';
import { ClaimService, Claim } from '@meridian/claims-service-client';
import { DocumentService } from '@meridian/document-service-client';
import { ClearinghouseClient } from '@meridian/clearinghouse-client';
import { TemplateEngine } from '@meridian/template-engine';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';
import { AppError } from '@meridian/shared-utils';

const logger = new HIPAALogger({ service: 'denial-appeal-workflow' });

// --- Types -------------------------------------------------------------------

interface AppealInput {
  claimId: string;
  denialReasonCode: string;
  remarkCodes: string[];
  originalChargeAmount: number;
  payerId: string;
  isAutoAppeal: boolean;
  initiatedBy: string;
}

interface AppealState {
  input: AppealInput;
  claim?: Claim;
  appealLetter?: GeneratedLetter;
  supportingDocIds: string[];
  reviewResult?: AppealReviewResult;
  submissionResult?: AppealSubmissionResult;
  trackingInfo?: AppealTrackingInfo;
  status: AppealStatus;
  errors: { step: string; error: string; timestamp: string }[];
}

type AppealStatus =
  | 'preparing'
  | 'letter_generated'
  | 'pending_review'
  | 'approved_for_submission'
  | 'submitting'
  | 'submitted'
  | 'payer_review'
  | 'overturned'
  | 'upheld'
  | 'withdrawn'
  | 'failed';

interface GeneratedLetter {
  templateId: string;
  content: string;
  documentId: string;
  generatedAt: string;
}

interface AppealReviewResult {
  approved: boolean;
  reviewedBy: string;
  reviewedAt: string;
  comments: string;
  modifications?: string; // reviewer might edit the letter
}

interface AppealSubmissionResult {
  submitted: boolean;
  submissionMethod: 'electronic' | 'fax' | 'mail';
  trackingNumber?: string;
  submittedAt: string;
}

interface AppealTrackingInfo {
  expectedResponseDate: string;
  followUpDates: string[];
  currentStatus: 'pending' | 'in_review' | 'decision_made';
  lastChecked?: string;
}

// --- Appeal Letter Templates -------------------------------------------------

// Map denial reason codes to appeal letter templates
const APPEAL_TEMPLATES: Record<string, string> = {
  '4':   'appeal_modifier_inconsistency',
  '16':  'appeal_missing_information',
  '18':  'appeal_duplicate_claim',
  '29':  'appeal_timely_filing',
  '50':  'appeal_non_covered_service',
  '96':  'appeal_non_covered_charge',
  '197': 'appeal_prior_auth',
  'DEFAULT': 'appeal_generic',
};

// Supporting document types needed for each denial reason
const REQUIRED_DOCUMENTS: Record<string, string[]> = {
  '4':   ['medical_record', 'procedure_notes'],
  '16':  ['medical_record', 'demographic_verification'],
  '18':  ['original_claim', 'proof_of_non_duplicate'],
  '29':  ['original_claim', 'proof_of_timely_submission'],
  '50':  ['medical_record', 'medical_necessity_letter'],
  '96':  ['medical_record', 'procedure_notes'],
  '197': ['prior_auth_request', 'medical_record'],
};

// --- Step 1: Generate Appeal Letter ------------------------------------------

const generateAppealLetterStep: WorkflowStep<AppealState> = {
  name: 'generate_appeal_letter',
  timeout: 15000,
  retries: 1,

  async execute(ctx: WorkflowContext<AppealState>): Promise<void> {
    ctx.state.status = 'preparing';
    const { claimId, denialReasonCode, payerId } = ctx.state.input;

    const claimService = new ClaimService();
    const claim = await claimService.getClaim(claimId);

    if (!claim) {
      throw new AppError(`Claim ${claimId} not found`, 'CLAIM_NOT_FOUND');
    }

    ctx.state.claim = claim;

    // Select the appropriate template
    const templateId = APPEAL_TEMPLATES[denialReasonCode] || APPEAL_TEMPLATES['DEFAULT'];

    logger.info('Generating appeal letter', {
      action: 'APPEAL_LETTER_GENERATE',
      claimId,
      denialReasonCode,
      templateId,
    });

    const templateEngine = new TemplateEngine();

    // Build the template context from claim data
    // Note: The template engine handles PHI carefully - it uses placeholder
    // tokens that get resolved only when the final document is rendered.
    const letterContent = await templateEngine.render(templateId, {
      claimNumber: claim.claimNumber,
      patientName: claim.patientName,
      patientDOB: claim.patientDOB,
      subscriberId: claim.subscriberId,
      serviceDate: claim.serviceDate,
      procedureCodes: claim.serviceLines.map((l: any) => l.procedureCode),
      diagnosisCodes: claim.diagnosisCodes.map((d: any) => d.code),
      chargeAmount: claim.totalCharge,
      denialReasonCode,
      denialReasonDescription: claim.denialReasonDescription,
      remarkCodes: ctx.state.input.remarkCodes,
      providerName: claim.providerName,
      providerNPI: claim.providerNPI,
      facilityName: claim.facilityName,
      payerName: claim.payerName,
      // Appeal-specific data
      appealDate: new Date().toISOString().split('T')[0],
      appealDeadline: calculateAppealDeadline(claim.denialDate, payerId),
    });

    // Store the letter as a document
    const documentService = new DocumentService();
    const doc = await documentService.createDocument({
      type: 'appeal_letter',
      claimId,
      patientId: claim.patientId,
      content: letterContent,
      format: 'pdf',
      metadata: {
        templateId,
        denialReasonCode,
        autoGenerated: true,
      },
    });

    ctx.state.appealLetter = {
      templateId,
      content: letterContent,
      documentId: doc.id,
      generatedAt: new Date().toISOString(),
    };

    ctx.state.status = 'letter_generated';

    logger.audit('Appeal letter generated', {
      action: 'PHI_CREATE',
      claimId,
      patientId: claim.patientId,
      documentId: doc.id,
      userId: ctx.state.input.initiatedBy,
      resource: 'Document',
    });
  },
};

function calculateAppealDeadline(denialDate: string, payerId: string): string {
  // Most payers allow 60-180 days for appeals
  // Medicare is 120 days, most commercial payers are 60-90 days
  // TODO: Build a payer-specific deadline lookup table. For now, default to 60.
  const days = payerId.startsWith('CMS') ? 120 : 60;
  const deadline = new Date(denialDate);
  deadline.setDate(deadline.getDate() + days);
  return deadline.toISOString().split('T')[0];
}

// --- Step 2: Attach Supporting Documents -------------------------------------

const attachSupportingDocsStep: WorkflowStep<AppealState> = {
  name: 'attach_supporting_docs',
  timeout: 30000,
  retries: 1,

  async execute(ctx: WorkflowContext<AppealState>): Promise<void> {
    const { claimId, denialReasonCode } = ctx.state.input;
    const documentService = new DocumentService();
    const docIds: string[] = [];

    const requiredTypes = REQUIRED_DOCUMENTS[denialReasonCode] || ['medical_record'];

    logger.info('Attaching supporting documents for appeal', {
      action: 'APPEAL_DOCS_ATTACH',
      claimId,
      requiredTypes,
    });

    for (const docType of requiredTypes) {
      try {
        // Find the most recent document of this type for the patient/claim
        const docs = await documentService.findDocuments({
          patientId: ctx.state.claim!.patientId,
          claimId,
          type: docType,
          limit: 1,
          sortBy: 'created_at',
          sortOrder: 'desc',
        });

        if (docs.length > 0) {
          docIds.push(docs[0].id);

          logger.audit('Document attached to appeal', {
            action: 'PHI_ACCESS',
            patientId: ctx.state.claim!.patientId,
            documentId: docs[0].id,
            userId: ctx.state.input.initiatedBy,
            resource: 'Document',
            purpose: 'appeal_attachment',
          });
        } else {
          logger.warn('Supporting document not found', {
            action: 'APPEAL_DOC_MISSING',
            claimId,
            documentType: docType,
          });
          // Missing documents are noted but don't block the appeal
          // The reviewer will decide if the appeal can proceed without them
        }
      } catch (error: any) {
        logger.error('Error fetching supporting document', {
          action: 'APPEAL_DOC_ERROR',
          claimId,
          documentType: docType,
          error: error.message,
        });
      }
    }

    ctx.state.supportingDocIds = docIds;
  },
};

// --- Step 3: Human Review (skipped for auto-appeals) -------------------------

const humanReviewStep: HumanStep<AppealState> = {
  name: 'human_review',
  type: 'human',
  timeout: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Skip this step for auto-appeals
  shouldSkip: async (ctx): Promise<boolean> => {
    return ctx.state.input.isAutoAppeal;
  },

  assignTo: async (ctx): Promise<string[]> => {
    return ['role:appeals_specialist'];
  },

  validateInput: async (ctx, input: AppealReviewResult): Promise<string | null> => {
    if (typeof input.approved !== 'boolean') {
      return 'Approval decision is required';
    }
    if (!input.comments || input.comments.length < 5) {
      return 'Comments are required';
    }
    return null;
  },

  async execute(ctx: WorkflowContext<AppealState>): Promise<void> {
    ctx.state.status = 'pending_review';

    logger.info('Appeal awaiting human review', {
      action: 'APPEAL_PENDING_REVIEW',
      claimId: ctx.state.input.claimId,
    });

    await ctx.waitForHumanInput();

    const review = ctx.humanInput as AppealReviewResult;
    ctx.state.reviewResult = {
      approved: review.approved,
      reviewedBy: ctx.userId,
      reviewedAt: new Date().toISOString(),
      comments: review.comments,
      modifications: review.modifications,
    };

    if (!review.approved) {
      ctx.state.status = 'withdrawn';

      // Update the claim status
      const claimService = new ClaimService();
      await claimService.updateClaim(ctx.state.input.claimId, {
        appealStatus: 'withdrawn',
        appealNotes: review.comments,
      });

      logger.info('Appeal withdrawn by reviewer', {
        action: 'APPEAL_WITHDRAWN',
        claimId: ctx.state.input.claimId,
        reviewedBy: ctx.userId,
      });

      // Stop the workflow
      ctx.abort('Appeal withdrawn by reviewer');
      return;
    }

    // If the reviewer modified the letter, update the document
    if (review.modifications) {
      const documentService = new DocumentService();
      await documentService.updateDocument(ctx.state.appealLetter!.documentId, {
        content: review.modifications,
        metadata: {
          modifiedBy: ctx.userId,
          modifiedAt: new Date().toISOString(),
          originalContent: ctx.state.appealLetter!.content,
        },
      });
      ctx.state.appealLetter!.content = review.modifications;
    }

    ctx.state.status = 'approved_for_submission';
  },
};

// --- Step 4: Submit Appeal ---------------------------------------------------

const submitAppealStep: WorkflowStep<AppealState> = {
  name: 'submit_appeal',
  timeout: 60000,
  retries: 2,
  retryDelay: 10000,

  async execute(ctx: WorkflowContext<AppealState>): Promise<void> {
    ctx.state.status = 'submitting';
    const { claimId, payerId } = ctx.state.input;

    // Determine submission method
    // Most payers accept electronic appeals now, but some still require fax/mail
    // TODO: Build a payer capability lookup. For now, try electronic first.
    const submissionMethod = determineSubmissionMethod(payerId);

    logger.info('Submitting appeal', {
      action: 'APPEAL_SUBMIT_START',
      claimId,
      payerId,
      submissionMethod,
    });

    try {
      if (submissionMethod === 'electronic') {
        const clearinghouse = new ClearinghouseClient({
          provider: 'change_healthcare',
          apiKey: process.env.CHANGE_HEALTHCARE_API_KEY!,
          environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
        });

        const result = await clearinghouse.submitAppeal({
          claimId,
          payerId,
          appealLetterId: ctx.state.appealLetter!.documentId,
          supportingDocIds: ctx.state.supportingDocIds,
        });

        ctx.state.submissionResult = {
          submitted: true,
          submissionMethod: 'electronic',
          trackingNumber: result.trackingNumber,
          submittedAt: new Date().toISOString(),
        };
      } else {
        // Fax submission
        // This uses a third-party fax service (currently RingCentral)
        // TODO: The fax path is janky. It works but it's not reliable.
        // We should look into payer portal automation as an alternative.
        const documentService = new DocumentService();

        const faxNumber = await getFaxNumberForPayer(payerId);

        await documentService.faxDocuments({
          faxNumber,
          documentIds: [
            ctx.state.appealLetter!.documentId,
            ...ctx.state.supportingDocIds,
          ],
          coverPage: {
            to: 'Appeals Department',
            from: 'Meridian Health - Revenue Cycle',
            claimNumber: ctx.state.claim!.claimNumber,
            pages: ctx.state.supportingDocIds.length + 2, // letter + cover + docs
          },
        });

        ctx.state.submissionResult = {
          submitted: true,
          submissionMethod: 'fax',
          submittedAt: new Date().toISOString(),
        };
      }

      ctx.state.status = 'submitted';

      // Update claim with appeal status
      const claimService = new ClaimService();
      await claimService.updateClaim(claimId, {
        appealStatus: 'submitted',
        appealSubmittedAt: ctx.state.submissionResult.submittedAt,
        appealTrackingNumber: ctx.state.submissionResult.trackingNumber,
      });

      logger.info('Appeal submitted successfully', {
        action: 'APPEAL_SUBMITTED',
        claimId,
        submissionMethod,
        trackingNumber: ctx.state.submissionResult.trackingNumber,
      });
    } catch (error: any) {
      ctx.state.errors.push({
        step: 'submit_appeal',
        error: error.message,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  },
};

function determineSubmissionMethod(payerId: string): 'electronic' | 'fax' {
  // Known payers that support electronic appeals
  const electronicPayers = [
    'CMS', 'BCBS', 'UHC', 'CIGNA', 'AETNA',
  ];

  return electronicPayers.some(p => payerId.toUpperCase().startsWith(p))
    ? 'electronic'
    : 'fax';
}

async function getFaxNumberForPayer(payerId: string): Promise<string> {
  // In a real implementation, this would look up from a payer directory
  // For now, we have a hardcoded mapping
  // TODO: Move to database lookup. This is embarrassing.
  const faxNumbers: Record<string, string> = {
    'HUMANA': '1-800-555-0100',
    'MOLINA': '1-800-555-0101',
    'CENTENE': '1-800-555-0102',
  };

  const prefix = payerId.split('-')[0].toUpperCase();
  return faxNumbers[prefix] || '1-800-555-0199'; // generic appeals fax
}

// --- Step 5: Track Response --------------------------------------------------

const trackResponseStep: WorkflowStep<AppealState> = {
  name: 'track_response',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<AppealState>): Promise<void> {
    ctx.state.status = 'payer_review';

    // Most payers must respond to appeals within 30-60 days
    const expectedDays = ctx.state.input.payerId.startsWith('CMS') ? 60 : 30;
    const expectedDate = new Date();
    expectedDate.setDate(expectedDate.getDate() + expectedDays);

    // Schedule follow-up checks
    const followUpDates: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const followUp = new Date();
      followUp.setDate(followUp.getDate() + (expectedDays / 3) * i);
      followUpDates.push(followUp.toISOString());
    }

    ctx.state.trackingInfo = {
      expectedResponseDate: expectedDate.toISOString(),
      followUpDates,
      currentStatus: 'pending',
    };

    // Schedule follow-up events
    for (const date of followUpDates) {
      await ctx.scheduleEvent('appeal_follow_up', {
        scheduledFor: date,
        data: {
          claimId: ctx.state.input.claimId,
          trackingNumber: ctx.state.submissionResult?.trackingNumber,
          payerId: ctx.state.input.payerId,
        },
      });
    }

    logger.info('Appeal tracking initialized', {
      action: 'APPEAL_TRACKING_STARTED',
      claimId: ctx.state.input.claimId,
      expectedResponseDate: expectedDate.toISOString(),
      followUpCount: followUpDates.length,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const appealDenialWorkflow = new WorkflowEngine<AppealInput, AppealState>({
  name: 'appeal_denial',
  version: '2.1.0',
  description: 'Generates and submits denial appeals with automated letter generation',

  initialState: (input: AppealInput): AppealState => ({
    input,
    supportingDocIds: [],
    status: 'preparing',
    errors: [],
  }),

  steps: [
    generateAppealLetterStep,
    attachSupportingDocsStep,
    humanReviewStep,
    submitAppealStep,
    trackResponseStep,
  ],

  criticalSteps: ['generate_appeal_letter', 'submit_appeal'],
  bestEffortSteps: ['attach_supporting_docs', 'track_response'],

  hooks: {
    onComplete: async (ctx) => {
      logger.info('Denial appeal workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        claimId: ctx.state.input.claimId,
        status: ctx.state.status,
        isAutoAppeal: ctx.state.input.isAutoAppeal,
        duration: ctx.duration,
      });
    },

    onError: async (ctx, error) => {
      ctx.state.status = 'failed';

      logger.error('Denial appeal workflow failed', {
        action: 'WORKFLOW_FAILED',
        claimId: ctx.state.input.claimId,
        error: error.message,
      });
    },
  },
});

export type { AppealInput, AppealState };
