/**
 * Referral Creation Workflow
 *
 * Creates a referral from a referring provider to a specialist or facility.
 * Handles insurance authorization verification, provider eligibility matching,
 * and notification to all parties.
 *
 * Owner: Care Coordination team
 * Note: Some payers require prior auth for referrals, others don't. The
 * workflow checks the payer rules and only requests auth when needed.
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { ReferralService, Referral } from '@meridian/referral-service-client';
import { EligibilityClient } from '@meridian/eligibility-client';
import { ProviderService, ProviderRecord } from '@meridian/provider-service-client';
import { NotificationService } from '@meridian/notification-service';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';
import { AppError, ValidationError } from '@meridian/shared-utils';

const logger = new HIPAALogger({ service: 'create-referral-workflow' });

// --- Types -------------------------------------------------------------------

interface CreateReferralInput {
  patientId: string;
  referringProviderId: string;
  specialtyCode: string;
  diagnosisCodes: string[];
  clinicalReason: string;
  urgency: 'routine' | 'urgent' | 'emergent';
  preferredProviderId?: string;
  preferredLocation?: string;
  insuranceInfo: {
    payerId: string;
    memberId: string;
    planType: string;
  };
  numberOfVisits: number;
  validFromDate: string;
  validToDate: string;
  createdBy: string;
}

interface CreateReferralState {
  input: CreateReferralInput;
  authorizationRequired: boolean;
  authorizationNumber?: string;
  authorizationStatus?: 'approved' | 'pending' | 'denied' | 'not_required';
  eligibleProviders: EligibleProvider[];
  selectedProviderId?: string;
  referral?: Referral;
  notificationsSent: string[];
  errors: { step: string; error: string; timestamp: string }[];
}

interface EligibleProvider {
  providerId: string;
  providerName: string;
  specialty: string;
  location: string;
  distance?: number; // miles from patient
  acceptingNewPatients: boolean;
  nextAvailableDate?: string;
  inNetwork: boolean;
  qualityScore?: number;
}

// --- Step 1: Verify Insurance Authorization ----------------------------------

const verifyAuthorizationStep: WorkflowStep<CreateReferralState> = {
  name: 'verify_authorization',
  timeout: 30000,
  retries: 2,
  retryDelay: 5000,

  async execute(ctx: WorkflowContext<CreateReferralState>): Promise<void> {
    const { insuranceInfo, specialtyCode, diagnosisCodes } = ctx.state.input;

    logger.info('Checking referral authorization requirements', {
      action: 'REFERRAL_AUTH_CHECK',
      patientId: ctx.state.input.patientId,
      payerId: insuranceInfo.payerId,
      specialty: specialtyCode,
    });

    const eligibilityClient = new EligibilityClient({ preferRealTime: true });

    // Check if this payer/plan requires prior auth for referrals
    // HMO plans almost always do, PPO plans usually don't
    const authRequirement = await eligibilityClient.checkAuthRequirement({
      payerId: insuranceInfo.payerId,
      memberId: insuranceInfo.memberId,
      serviceType: 'referral',
      specialtyCode,
      diagnosisCodes,
    });

    ctx.state.authorizationRequired = authRequirement.required;

    if (!authRequirement.required) {
      ctx.state.authorizationStatus = 'not_required';
      logger.info('No prior auth required for referral', {
        action: 'REFERRAL_AUTH_NOT_REQUIRED',
        payerId: insuranceInfo.payerId,
        planType: insuranceInfo.planType,
      });
      return;
    }

    // Request authorization
    try {
      const authResult = await eligibilityClient.requestAuthorization({
        payerId: insuranceInfo.payerId,
        memberId: insuranceInfo.memberId,
        referringProviderId: ctx.state.input.referringProviderId,
        specialtyCode,
        diagnosisCodes,
        numberOfVisits: ctx.state.input.numberOfVisits,
        validFrom: ctx.state.input.validFromDate,
        validTo: ctx.state.input.validToDate,
        clinicalReason: ctx.state.input.clinicalReason,
        urgency: ctx.state.input.urgency,
      });

      ctx.state.authorizationNumber = authResult.authorizationNumber;
      ctx.state.authorizationStatus = authResult.status;

      if (authResult.status === 'denied') {
        logger.warn('Referral authorization denied', {
          action: 'REFERRAL_AUTH_DENIED',
          payerId: insuranceInfo.payerId,
          reason: authResult.denialReason,
        });

        // For urgent/emergent referrals, we proceed even without auth
        // and handle the auth issue later. Patient care comes first.
        if (ctx.state.input.urgency !== 'routine') {
          ctx.state.errors.push({
            step: 'verify_authorization',
            error: `Auth denied: ${authResult.denialReason}. Proceeding due to ${ctx.state.input.urgency} urgency.`,
            timestamp: new Date().toISOString(),
          });
        } else {
          throw new AppError(
            `Authorization denied: ${authResult.denialReason}`,
            'AUTH_DENIED'
          );
        }
      }

      logger.info('Referral authorization obtained', {
        action: 'REFERRAL_AUTH_OBTAINED',
        authorizationNumber: authResult.authorizationNumber,
        status: authResult.status,
      });
    } catch (error: any) {
      if (error.code === 'AUTH_DENIED' && ctx.state.input.urgency === 'routine') {
        throw error;
      }
      // For payer API failures, note it and proceed
      ctx.state.authorizationStatus = 'pending';
      ctx.state.errors.push({
        step: 'verify_authorization',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  },
};

// --- Step 2: Find Eligible Providers -----------------------------------------

const findEligibleProvidersStep: WorkflowStep<CreateReferralState> = {
  name: 'find_eligible_providers',
  timeout: 15000,
  retries: 1,

  async execute(ctx: WorkflowContext<CreateReferralState>): Promise<void> {
    const { specialtyCode, preferredProviderId, preferredLocation, insuranceInfo } = ctx.state.input;

    const providerService = new ProviderService();

    logger.info('Finding eligible providers for referral', {
      action: 'REFERRAL_PROVIDER_SEARCH',
      specialty: specialtyCode,
      preferredProviderId,
    });

    // Search for providers matching the specialty
    const searchResults = await providerService.searchProviders({
      specialtyCode,
      payerId: insuranceInfo.payerId,
      location: preferredLocation,
      acceptingNewPatients: true,
      credentialingStatus: 'active',
      maxResults: 20,
      sortBy: 'distance',
    });

    ctx.state.eligibleProviders = searchResults.map((p: ProviderRecord) => ({
      providerId: p.id,
      providerName: `${p.firstName} ${p.lastName}`,
      specialty: p.specialtyDescription,
      location: p.primaryLocation,
      distance: p.distanceFromPatient,
      acceptingNewPatients: p.acceptingNewPatients,
      nextAvailableDate: p.nextAvailableDate,
      inNetwork: p.networkStatus === 'in_network',
      qualityScore: p.qualityScore,
    }));

    // If there's a preferred provider, make sure they're in the list
    if (preferredProviderId) {
      const preferred = ctx.state.eligibleProviders.find(
        p => p.providerId === preferredProviderId
      );

      if (preferred) {
        ctx.state.selectedProviderId = preferredProviderId;
      } else {
        // Check if the preferred provider exists but isn't in network
        const preferredRecord = await providerService.getProvider(preferredProviderId);
        if (preferredRecord) {
          ctx.state.eligibleProviders.unshift({
            providerId: preferredRecord.id,
            providerName: `${preferredRecord.firstName} ${preferredRecord.lastName}`,
            specialty: preferredRecord.specialtyDescription,
            location: preferredRecord.primaryLocation,
            acceptingNewPatients: preferredRecord.acceptingNewPatients,
            inNetwork: false,
            qualityScore: preferredRecord.qualityScore,
          });

          // Still use the preferred provider - the referring doc knows best
          ctx.state.selectedProviderId = preferredProviderId;

          ctx.state.errors.push({
            step: 'find_eligible_providers',
            error: 'Preferred provider is out of network - patient may have higher costs',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // If no preferred provider selected, pick the best match
    if (!ctx.state.selectedProviderId && ctx.state.eligibleProviders.length > 0) {
      // Prioritize: in-network > accepting new patients > quality score > distance
      const sorted = [...ctx.state.eligibleProviders].sort((a, b) => {
        if (a.inNetwork !== b.inNetwork) return a.inNetwork ? -1 : 1;
        if (a.acceptingNewPatients !== b.acceptingNewPatients) {
          return a.acceptingNewPatients ? -1 : 1;
        }
        if ((a.qualityScore || 0) !== (b.qualityScore || 0)) {
          return (b.qualityScore || 0) - (a.qualityScore || 0);
        }
        return (a.distance || Infinity) - (b.distance || Infinity);
      });

      ctx.state.selectedProviderId = sorted[0].providerId;
    }

    if (ctx.state.eligibleProviders.length === 0) {
      logger.warn('No eligible providers found for referral', {
        action: 'REFERRAL_NO_PROVIDERS',
        specialty: specialtyCode,
        payerId: insuranceInfo.payerId,
      });
      // Don't fail - the referral can be created without a selected provider
      // The care coordinator will manually assign one
    }

    logger.info('Provider search complete', {
      action: 'REFERRAL_PROVIDERS_FOUND',
      totalFound: ctx.state.eligibleProviders.length,
      inNetwork: ctx.state.eligibleProviders.filter(p => p.inNetwork).length,
      selectedProvider: ctx.state.selectedProviderId,
    });
  },
};

// --- Step 3: Create Referral -------------------------------------------------

const createReferralStep: WorkflowStep<CreateReferralState> = {
  name: 'create_referral',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<CreateReferralState>): Promise<void> {
    const referralService = new ReferralService();

    logger.info('Creating referral record', {
      action: 'REFERRAL_CREATE',
      patientId: ctx.state.input.patientId,
      referringProviderId: ctx.state.input.referringProviderId,
    });

    const referral = await referralService.createReferral({
      patientId: ctx.state.input.patientId,
      referringProviderId: ctx.state.input.referringProviderId,
      referredToProviderId: ctx.state.selectedProviderId,
      specialtyCode: ctx.state.input.specialtyCode,
      diagnosisCodes: ctx.state.input.diagnosisCodes,
      clinicalReason: ctx.state.input.clinicalReason,
      urgency: ctx.state.input.urgency,
      authorizationNumber: ctx.state.authorizationNumber,
      authorizationStatus: ctx.state.authorizationStatus || 'not_required',
      numberOfVisits: ctx.state.input.numberOfVisits,
      validFromDate: ctx.state.input.validFromDate,
      validToDate: ctx.state.input.validToDate,
      status: 'active',
      createdBy: ctx.state.input.createdBy,
    });

    ctx.state.referral = referral;

    // Publish event
    const eventBus = new EventBus();
    await eventBus.publish('referral.created', {
      referralId: referral.id,
      patientId: ctx.state.input.patientId,
      referringProviderId: ctx.state.input.referringProviderId,
      referredToProviderId: ctx.state.selectedProviderId,
      urgency: ctx.state.input.urgency,
      timestamp: new Date().toISOString(),
    });

    logger.audit('Referral created', {
      action: 'PHI_CREATE',
      patientId: ctx.state.input.patientId,
      referralId: referral.id,
      userId: ctx.state.input.createdBy,
      resource: 'Referral',
    });
  },
};

// --- Step 4: Notify Parties --------------------------------------------------

const notifyPartiesStep: WorkflowStep<CreateReferralState> = {
  name: 'notify_parties',
  timeout: 15000,
  retries: 2,

  async execute(ctx: WorkflowContext<CreateReferralState>): Promise<void> {
    if (!ctx.state.referral) {
      throw new AppError('Cannot notify without referral record');
    }

    const notificationService = new NotificationService();
    const sentTo: string[] = [];

    // Notify the referred-to provider
    if (ctx.state.selectedProviderId) {
      try {
        await notificationService.send({
          recipientId: ctx.state.selectedProviderId,
          channel: 'secure_message', // HIPAA-compliant channel
          template: 'referral_received',
          data: {
            referralId: ctx.state.referral.id,
            patientId: ctx.state.input.patientId,
            referringProviderName: ctx.state.referral.referringProviderName,
            urgency: ctx.state.input.urgency,
            clinicalReason: ctx.state.input.clinicalReason,
            diagnosisCodes: ctx.state.input.diagnosisCodes,
          },
          priority: ctx.state.input.urgency === 'emergent' ? 'urgent' : 'normal',
        });
        sentTo.push('referred_provider');
      } catch (error: any) {
        ctx.state.errors.push({
          step: 'notify_parties',
          error: `Failed to notify referred provider: ${error.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Notify the patient
    try {
      await notificationService.send({
        recipientId: ctx.state.input.patientId,
        channel: 'portal', // Patient portal notification
        template: 'referral_created_patient',
        data: {
          referralId: ctx.state.referral.id,
          specialtyName: ctx.state.referral.specialtyDescription,
          providerName: ctx.state.eligibleProviders.find(
            p => p.providerId === ctx.state.selectedProviderId
          )?.providerName || 'Pending assignment',
          urgency: ctx.state.input.urgency,
          validFrom: ctx.state.input.validFromDate,
          validTo: ctx.state.input.validToDate,
          numberOfVisits: ctx.state.input.numberOfVisits,
          // Don't include clinical details in patient notification - they
          // can see those in their portal
        },
        priority: 'normal',
      });
      sentTo.push('patient');
    } catch (error: any) {
      ctx.state.errors.push({
        step: 'notify_parties',
        error: `Failed to notify patient: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Notify the referring provider (confirmation)
    try {
      await notificationService.send({
        recipientId: ctx.state.input.referringProviderId,
        channel: 'ehr_inbox', // Direct into their EHR inbox
        template: 'referral_confirmation',
        data: {
          referralId: ctx.state.referral.id,
          patientId: ctx.state.input.patientId,
          referredToProvider: ctx.state.eligibleProviders.find(
            p => p.providerId === ctx.state.selectedProviderId
          )?.providerName,
          authorizationNumber: ctx.state.authorizationNumber,
          authorizationStatus: ctx.state.authorizationStatus,
        },
        priority: 'normal',
      });
      sentTo.push('referring_provider');
    } catch (error: any) {
      ctx.state.errors.push({
        step: 'notify_parties',
        error: `Failed to notify referring provider: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    }

    ctx.state.notificationsSent = sentTo;

    logger.info('Referral notifications sent', {
      action: 'REFERRAL_NOTIFICATIONS_SENT',
      referralId: ctx.state.referral.id,
      notifiedParties: sentTo,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const createReferralWorkflow = new WorkflowEngine<CreateReferralInput, CreateReferralState>({
  name: 'create_referral',
  version: '1.4.0',
  description: 'Creates a referral with authorization verification and provider matching',

  initialState: (input: CreateReferralInput): CreateReferralState => ({
    input,
    authorizationRequired: false,
    eligibleProviders: [],
    notificationsSent: [],
    errors: [],
  }),

  steps: [
    verifyAuthorizationStep,
    findEligibleProvidersStep,
    createReferralStep,
    notifyPartiesStep,
  ],

  criticalSteps: ['create_referral'],
  bestEffortSteps: ['verify_authorization', 'find_eligible_providers', 'notify_parties'],

  hooks: {
    onComplete: async (ctx) => {
      logger.info('Create referral workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        referralId: ctx.state.referral?.id,
        authRequired: ctx.state.authorizationRequired,
        authStatus: ctx.state.authorizationStatus,
        providersFound: ctx.state.eligibleProviders.length,
        duration: ctx.duration,
      });
    },
  },
});

export type { CreateReferralInput, CreateReferralState };
