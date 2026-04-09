/**
 * Patient Intake Workflow
 *
 * Orchestrates the onboarding of a new patient into the Meridian Health system.
 * Steps are executed sequentially; failure at any step triggers compensating
 * actions for the steps that already completed (saga pattern, loosely).
 *
 * Owner: Patient Access team
 * Last major refactor: 2025-06-14 (moved insurance check to async)
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { PatientDemographics, InsuranceInfo, PatientRecord } from '@meridian/patient-types';
import { validate as validateDemographics } from '@meridian/demographics-validator';
import { EligibilityClient } from '@meridian/eligibility-client';
import { PatientService } from '@meridian/patient-service-client';
import { NotificationService } from '@meridian/notification-service';
import { SchedulingService } from '@meridian/scheduling-client';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { AppError, ValidationError } from '@meridian/shared-utils';
import { EventBus, PatientCreatedEvent } from '@meridian/event-bus';

const logger = new HIPAALogger({ service: 'patient-intake-workflow' });

// --- Types -------------------------------------------------------------------

interface PatientIntakeInput {
  demographics: PatientDemographics;
  insurance: InsuranceInfo;
  preferredLocation?: string;
  referringProvider?: string;
  consentTimestamp: string; // ISO 8601 - when patient signed consent forms
  source: 'portal' | 'ehr_import' | 'call_center' | 'kiosk';
}

interface PatientIntakeState {
  input: PatientIntakeInput;
  demographicsValid: boolean;
  eligibilityResult?: EligibilityResult;
  patientRecord?: PatientRecord;
  welcomePacketSent: boolean;
  appointmentId?: string;
  errors: StepError[];
}

interface EligibilityResult {
  eligible: boolean;
  planName: string;
  groupNumber: string;
  copay: number; // cents
  deductibleRemaining: number; // cents
  priorAuthRequired: boolean;
  effectiveDate: string;
  terminationDate: string | null;
  warnings: string[];
}

interface StepError {
  step: string;
  error: string;
  timestamp: string;
  retryable: boolean;
}

// --- Validation Step ---------------------------------------------------------

const validateDemographicsStep: WorkflowStep<PatientIntakeState> = {
  name: 'validate_demographics',
  timeout: 5000,
  retries: 0, // validation is deterministic, no point retrying

  async execute(ctx: WorkflowContext<PatientIntakeState>): Promise<void> {
    const { demographics } = ctx.state.input;

    logger.info('Validating patient demographics', {
      action: 'DEMOGRAPHICS_VALIDATION',
      // NOTE: We log MRN but never log the actual demographic values here
      source: ctx.state.input.source,
    });

    const result = validateDemographics(demographics);

    if (!result.valid) {
      ctx.state.demographicsValid = false;
      ctx.state.errors.push({
        step: 'validate_demographics',
        error: `Validation failed: ${result.errors.join('; ')}`,
        timestamp: new Date().toISOString(),
        retryable: false,
      });
      throw new ValidationError(
        `Demographics validation failed: ${result.errors.join('; ')}`,
        result.errors
      );
    }

    // Check for duplicate patient
    const patientService = new PatientService();
    const duplicates = await patientService.findDuplicates({
      firstName: demographics.firstName,
      lastName: demographics.lastName,
      dateOfBirth: demographics.dateOfBirth,
      ssn4: demographics.ssn?.slice(-4),
    });

    if (duplicates.length > 0) {
      logger.warn('Potential duplicate patient detected', {
        action: 'DUPLICATE_CHECK',
        duplicateCount: duplicates.length,
        // Don't log the duplicate MRNs - that's cross-patient PHI leakage
      });

      // We don't block on duplicates - flag for manual review
      // TODO: This should be configurable per organization. Some orgs want
      // to block hard on duplicates, especially after the incident in Q3 2025
      // where we created 47 duplicate records for the same patient.
      ctx.metadata.set('potential_duplicates', duplicates.length);
    }

    ctx.state.demographicsValid = true;
  },
};

// --- Insurance Eligibility Step ----------------------------------------------

const checkInsuranceEligibilityStep: WorkflowStep<PatientIntakeState> = {
  name: 'check_insurance_eligibility',
  timeout: 30000, // payer APIs can be very slow
  retries: 2,
  retryDelay: 3000,

  async execute(ctx: WorkflowContext<PatientIntakeState>): Promise<void> {
    const { insurance, demographics } = ctx.state.input;

    logger.info('Checking insurance eligibility', {
      action: 'ELIGIBILITY_CHECK',
      payerId: insurance.payerId,
      // Never log member ID or group number
    });

    const eligibilityClient = new EligibilityClient({
      // Use the X12 270/271 transaction path for real-time eligibility
      // Some payers still don't support real-time so we fall back to batch
      preferRealTime: true,
    });

    try {
      const result = await eligibilityClient.checkEligibility({
        memberId: insurance.memberId,
        payerId: insurance.payerId,
        dateOfBirth: demographics.dateOfBirth,
        serviceDate: new Date().toISOString().split('T')[0],
        serviceType: '30', // General medical
        npi: ctx.state.input.referringProvider || undefined,
      });

      ctx.state.eligibilityResult = {
        eligible: result.eligible,
        planName: result.planName,
        groupNumber: result.groupNumber,
        copay: result.copayAmount,
        deductibleRemaining: result.deductibleRemaining,
        priorAuthRequired: result.priorAuthRequired,
        effectiveDate: result.effectiveDate,
        terminationDate: result.terminationDate,
        warnings: result.warnings || [],
      };

      if (!result.eligible) {
        logger.warn('Patient insurance not eligible', {
          action: 'ELIGIBILITY_FAILED',
          payerId: insurance.payerId,
          reason: result.denialReason,
        });
        // We don't throw here - ineligible patients can still be onboarded
        // as self-pay. The downstream consumer decides.
      }
    } catch (error: any) {
      // Eligibility check failures should not block intake
      // This is a business decision - we'd rather onboard the patient and
      // sort out insurance later than lose them entirely.
      logger.error('Eligibility check failed, proceeding with intake', {
        action: 'ELIGIBILITY_ERROR',
        payerId: insurance.payerId,
        errorCode: error.code,
        errorMessage: error.message,
      });

      ctx.state.errors.push({
        step: 'check_insurance_eligibility',
        error: error.message,
        timestamp: new Date().toISOString(),
        retryable: true,
      });

      // Queue a retry for later
      await ctx.scheduleRetry('check_insurance_eligibility', {
        delay: '15m',
        maxAttempts: 5,
      });
    }
  },
};

// --- Create Patient Record Step ----------------------------------------------

const createPatientRecordStep: WorkflowStep<PatientIntakeState> = {
  name: 'create_patient_record',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<PatientIntakeState>): Promise<void> {
    const { demographics, insurance, consentTimestamp, source } = ctx.state.input;

    const patientService = new PatientService();

    logger.info('Creating patient record', {
      action: 'PATIENT_CREATE',
      source,
    });

    const record = await patientService.createPatient({
      demographics,
      insurance: ctx.state.eligibilityResult?.eligible !== false ? insurance : undefined,
      consentTimestamp,
      source,
      status: 'active',
      // If eligibility failed or is pending, mark for follow-up
      insuranceStatus: ctx.state.eligibilityResult
        ? (ctx.state.eligibilityResult.eligible ? 'verified' : 'ineligible')
        : 'pending_verification',
    });

    ctx.state.patientRecord = record;

    // Publish domain event
    const eventBus = new EventBus();
    await eventBus.publish<PatientCreatedEvent>('patient.created', {
      patientId: record.id,
      mrn: record.mrn,
      source,
      timestamp: new Date().toISOString(),
    });

    logger.audit('Patient record created', {
      action: 'PHI_CREATE',
      patientId: record.id,
      userId: ctx.userId,
      resource: 'Patient',
    });
  },

  async compensate(ctx: WorkflowContext<PatientIntakeState>): Promise<void> {
    // If downstream steps fail, we need to mark this record as incomplete
    // rather than deleting it (we never hard-delete patient records for
    // compliance reasons)
    if (ctx.state.patientRecord) {
      const patientService = new PatientService();
      await patientService.updateStatus(ctx.state.patientRecord.id, 'intake_incomplete');

      logger.audit('Patient record marked as incomplete due to workflow failure', {
        action: 'PHI_UPDATE',
        patientId: ctx.state.patientRecord.id,
        userId: 'system',
        resource: 'Patient',
      });
    }
  },
};

// --- Send Welcome Packet Step ------------------------------------------------

const sendWelcomePacketStep: WorkflowStep<PatientIntakeState> = {
  name: 'send_welcome_packet',
  timeout: 15000,
  retries: 2,

  async execute(ctx: WorkflowContext<PatientIntakeState>): Promise<void> {
    if (!ctx.state.patientRecord) {
      throw new AppError('Cannot send welcome packet without patient record');
    }

    const notificationService = new NotificationService();

    const { demographics } = ctx.state.input;
    const preferredChannel = demographics.communicationPreference || 'email';

    // HIPAA: Welcome packet itself doesn't contain PHI, just generic info
    // and a link to the patient portal. Safe to send via email.
    try {
      await notificationService.send({
        recipientId: ctx.state.patientRecord.id,
        channel: preferredChannel,
        template: 'patient_welcome',
        data: {
          firstName: demographics.firstName,
          portalUrl: `https://portal.meridianhealth.io/activate?token=${ctx.state.patientRecord.activationToken}`,
          locationName: ctx.state.input.preferredLocation || 'Meridian Health',
          // Don't include any clinical info in the welcome packet
        },
        priority: 'normal',
      });

      ctx.state.welcomePacketSent = true;
    } catch (error: any) {
      // Welcome packet failure is non-critical
      logger.warn('Failed to send welcome packet', {
        action: 'NOTIFICATION_FAILED',
        patientId: ctx.state.patientRecord.id,
        channel: preferredChannel,
        error: error.message,
      });

      ctx.state.welcomePacketSent = false;
      ctx.state.errors.push({
        step: 'send_welcome_packet',
        error: error.message,
        timestamp: new Date().toISOString(),
        retryable: true,
      });

      // Don't throw - this step is best-effort
    }
  },
};

// --- Schedule Initial Appointment Step ---------------------------------------

const scheduleInitialAppointmentStep: WorkflowStep<PatientIntakeState> = {
  name: 'schedule_initial_appointment',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<PatientIntakeState>): Promise<void> {
    if (!ctx.state.patientRecord) {
      throw new AppError('Cannot schedule appointment without patient record');
    }

    const schedulingService = new SchedulingService();

    // Only auto-schedule if the patient came through the portal or kiosk
    // Call center patients already have appointments scheduled by the agent
    if (ctx.state.input.source === 'call_center') {
      logger.info('Skipping auto-schedule for call center intake', {
        action: 'SCHEDULE_SKIP',
        patientId: ctx.state.patientRecord.id,
      });
      return;
    }

    try {
      // Find the next available slot for a new patient visit
      const slots = await schedulingService.findAvailableSlots({
        appointmentType: 'new_patient',
        locationId: ctx.state.input.preferredLocation,
        providerId: ctx.state.input.referringProvider,
        startDate: new Date().toISOString(),
        // Look 4 weeks out for availability
        endDate: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
        duration: 60, // new patient visits are 60 min
      });

      if (slots.length === 0) {
        logger.warn('No available slots for new patient appointment', {
          action: 'SCHEDULE_NO_SLOTS',
          patientId: ctx.state.patientRecord.id,
          location: ctx.state.input.preferredLocation,
        });

        // Queue for waitlist
        await schedulingService.addToWaitlist({
          patientId: ctx.state.patientRecord.id,
          appointmentType: 'new_patient',
          preferredLocation: ctx.state.input.preferredLocation,
        });

        return;
      }

      // Book the earliest available slot
      const appointment = await schedulingService.bookAppointment({
        patientId: ctx.state.patientRecord.id,
        slotId: slots[0].id,
        appointmentType: 'new_patient',
        notes: 'Auto-scheduled during patient intake',
      });

      ctx.state.appointmentId = appointment.id;

      logger.info('Initial appointment scheduled', {
        action: 'APPOINTMENT_CREATED',
        patientId: ctx.state.patientRecord.id,
        appointmentId: appointment.id,
      });
    } catch (error: any) {
      // Scheduling failure is non-critical for intake
      logger.error('Failed to schedule initial appointment', {
        action: 'SCHEDULE_ERROR',
        patientId: ctx.state.patientRecord.id,
        error: error.message,
      });

      ctx.state.errors.push({
        step: 'schedule_initial_appointment',
        error: error.message,
        timestamp: new Date().toISOString(),
        retryable: true,
      });

      // Don't throw - patient is still onboarded even without appointment
    }
  },
};

// --- Workflow Definition -----------------------------------------------------

export const patientIntakeWorkflow = new WorkflowEngine<PatientIntakeInput, PatientIntakeState>({
  name: 'patient_intake',
  version: '2.3.0',
  description: 'Onboards a new patient into the Meridian Health system',

  initialState: (input: PatientIntakeInput): PatientIntakeState => ({
    input,
    demographicsValid: false,
    welcomePacketSent: false,
    errors: [],
  }),

  steps: [
    validateDemographicsStep,
    checkInsuranceEligibilityStep,
    createPatientRecordStep,
    sendWelcomePacketStep,
    scheduleInitialAppointmentStep,
  ],

  // Steps that are critical - workflow fails if these fail
  criticalSteps: ['validate_demographics', 'create_patient_record'],

  // Steps that are best-effort - workflow succeeds even if these fail
  bestEffortSteps: ['send_welcome_packet', 'schedule_initial_appointment'],

  hooks: {
    onComplete: async (ctx) => {
      logger.info('Patient intake workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        patientId: ctx.state.patientRecord?.id,
        errorsCount: ctx.state.errors.length,
        duration: ctx.duration,
      });
    },

    onError: async (ctx, error) => {
      logger.error('Patient intake workflow failed', {
        action: 'WORKFLOW_FAILED',
        step: ctx.currentStep,
        error: error.message,
        errorsCount: ctx.state.errors.length,
      });
    },
  },
});

// --- Convenience executor ----------------------------------------------------

export async function executePatientIntake(
  input: PatientIntakeInput,
  userId: string
): Promise<{
  success: boolean;
  patientId?: string;
  mrn?: string;
  appointmentId?: string;
  errors: StepError[];
  warnings: string[];
}> {
  const result = await patientIntakeWorkflow.execute(input, { userId });

  return {
    success: result.status === 'completed',
    patientId: result.state.patientRecord?.id,
    mrn: result.state.patientRecord?.mrn,
    appointmentId: result.state.appointmentId,
    errors: result.state.errors,
    warnings: result.state.eligibilityResult?.warnings || [],
  };
}
