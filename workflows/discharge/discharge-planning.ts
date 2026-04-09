/**
 * Discharge Planning Workflow
 *
 * Manages the discharge process from medication reconciliation through
 * care instruction delivery and PCP notification.
 *
 * Owner: Care Transitions team
 *
 * TODO: Add home health coordination step. Currently, patients who need
 * home health services have to be coordinated manually by the case manager.
 * This is a significant gap - about 15% of our discharges need home health
 * and the manual process delays discharge by 2-4 hours on average.
 * Ticket: MH-3892 (assigned to Care Transitions team, Q3 2026)
 *
 * TODO: Add DME (durable medical equipment) ordering step.
 * Ticket: MH-4102 (not yet assigned)
 *
 * TODO: Integrate with pharmacy for medication delivery scheduling.
 * Currently patients have to call the pharmacy themselves.
 * Ticket: MH-4301 (backlog)
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { PatientService } from '@meridian/patient-service-client';
import { MedicationService, Medication } from '@meridian/medication-service-client';
import { SchedulingService } from '@meridian/scheduling-client';
import { DocumentService } from '@meridian/document-service-client';
import { NotificationService } from '@meridian/notification-service';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';
import { AppError } from '@meridian/shared-utils';

const logger = new HIPAALogger({ service: 'discharge-planning-workflow' });

// --- Types -------------------------------------------------------------------

interface DischargePlanningInput {
  patientId: string;
  encounterId: string;
  attendingProviderId: string;
  pcpId?: string; // Primary Care Physician - some patients don't have one
  dischargeDate: string;
  dischargeDisposition: DischargeDisposition;
  dischargeDiagnoses: string[];
  newMedications: MedicationOrder[];
  discontinuedMedications: string[]; // medication IDs
  followUpNeeded: FollowUpOrder[];
  specialInstructions?: string;
  dischargedBy: string;
}

type DischargeDisposition =
  | 'home'
  | 'home_with_services' // home health, visiting nurse, etc.
  | 'snf' // skilled nursing facility
  | 'rehab'
  | 'ltac' // long-term acute care
  | 'ama' // against medical advice
  | 'expired';

interface MedicationOrder {
  name: string;
  dosage: string;
  frequency: string;
  route: string;
  duration?: string;
  instructions: string;
  pharmacyId?: string;
}

interface FollowUpOrder {
  type: 'office_visit' | 'lab_work' | 'imaging' | 'therapy' | 'specialist';
  providerId?: string;
  specialtyCode?: string;
  timeframe: string; // e.g., "7 days", "2 weeks", "1 month"
  reason: string;
  priority: 'routine' | 'urgent';
}

interface DischargePlanningState {
  input: DischargePlanningInput;
  medReconciliation?: MedReconciliationResult;
  followUpAppointments: ScheduledFollowUp[];
  careInstructionsDocId?: string;
  pcpNotified: boolean;
  errors: { step: string; error: string; timestamp: string }[];
}

interface MedReconciliationResult {
  reconciledAt: string;
  reconciledBy: string;
  currentMedications: ReconciledMedication[];
  interactions: MedicationInteraction[];
  warnings: string[];
}

interface ReconciledMedication {
  name: string;
  dosage: string;
  frequency: string;
  status: 'continued' | 'new' | 'modified' | 'discontinued';
  instructions: string;
}

interface MedicationInteraction {
  medication1: string;
  medication2: string;
  severity: 'low' | 'moderate' | 'high';
  description: string;
}

interface ScheduledFollowUp {
  type: string;
  appointmentId?: string;
  scheduledDate?: string;
  providerName?: string;
  status: 'scheduled' | 'pending' | 'failed';
  notes?: string;
}

// --- Step 1: Medication Reconciliation ---------------------------------------

const medicationReconciliationStep: WorkflowStep<DischargePlanningState> = {
  name: 'medication_reconciliation',
  timeout: 20000,
  retries: 1,

  async execute(ctx: WorkflowContext<DischargePlanningState>): Promise<void> {
    const { patientId, newMedications, discontinuedMedications, encounterId } = ctx.state.input;

    const medicationService = new MedicationService();

    logger.info('Starting medication reconciliation', {
      action: 'MED_RECONCILIATION_START',
      patientId,
      encounterId,
      newMedCount: newMedications.length,
      discontinuedCount: discontinuedMedications.length,
    });

    // Get current medication list
    const currentMeds = await medicationService.getActiveMedications(patientId);

    // Build reconciled list
    const reconciledMeds: ReconciledMedication[] = [];

    // Existing medications that aren't being discontinued
    for (const med of currentMeds) {
      if (discontinuedMedications.includes(med.id)) {
        reconciledMeds.push({
          name: med.name,
          dosage: med.dosage,
          frequency: med.frequency,
          status: 'discontinued',
          instructions: 'STOP taking this medication',
        });
      } else {
        reconciledMeds.push({
          name: med.name,
          dosage: med.dosage,
          frequency: med.frequency,
          status: 'continued',
          instructions: med.instructions || 'Continue as previously directed',
        });
      }
    }

    // New medications
    for (const newMed of newMedications) {
      // Check if this replaces an existing med (same drug class, different dosage)
      const existingMatch = currentMeds.find(
        (m: Medication) => m.drugClass === newMed.name // This is a simplification
      );

      reconciledMeds.push({
        name: newMed.name,
        dosage: newMed.dosage,
        frequency: newMed.frequency,
        status: existingMatch ? 'modified' : 'new',
        instructions: newMed.instructions,
      });
    }

    // Check for drug interactions
    const activemedNames = reconciledMeds
      .filter(m => m.status !== 'discontinued')
      .map(m => m.name);

    const interactions = await medicationService.checkInteractions(activemedNames);

    const warnings: string[] = [];
    const highSeverity = interactions.filter((i: MedicationInteraction) => i.severity === 'high');

    if (highSeverity.length > 0) {
      warnings.push(
        `HIGH SEVERITY INTERACTIONS DETECTED: ${highSeverity.map(
          (i: MedicationInteraction) => `${i.medication1} + ${i.medication2}`
        ).join('; ')}`
      );

      // High-severity interactions require pharmacist review
      // This doesn't block discharge but flags it
      logger.warn('High-severity drug interaction detected at discharge', {
        action: 'MED_INTERACTION_HIGH',
        patientId,
        interactionCount: highSeverity.length,
      });
    }

    // Update the medication list in the system
    await medicationService.reconcile(patientId, {
      encounterId,
      medications: reconciledMeds,
      reconciledBy: ctx.state.input.dischargedBy,
    });

    ctx.state.medReconciliation = {
      reconciledAt: new Date().toISOString(),
      reconciledBy: ctx.state.input.dischargedBy,
      currentMedications: reconciledMeds,
      interactions,
      warnings,
    };

    logger.audit('Medication reconciliation completed', {
      action: 'PHI_UPDATE',
      patientId,
      userId: ctx.state.input.dischargedBy,
      resource: 'MedicationList',
      medicationCount: reconciledMeds.length,
    });
  },
};

// --- Step 2: Schedule Follow-up Appointments ---------------------------------

const scheduleFollowUpsStep: WorkflowStep<DischargePlanningState> = {
  name: 'schedule_follow_ups',
  timeout: 30000,
  retries: 1,

  async execute(ctx: WorkflowContext<DischargePlanningState>): Promise<void> {
    const { patientId, followUpNeeded, dischargeDate } = ctx.state.input;
    const schedulingService = new SchedulingService();
    const followUps: ScheduledFollowUp[] = [];

    logger.info('Scheduling follow-up appointments', {
      action: 'FOLLOWUP_SCHEDULE_START',
      patientId,
      followUpCount: followUpNeeded.length,
    });

    for (const order of followUpNeeded) {
      try {
        // Calculate target date from timeframe
        const targetDate = calculateTargetDate(dischargeDate, order.timeframe);

        const slots = await schedulingService.findAvailableSlots({
          appointmentType: order.type,
          providerId: order.providerId,
          specialtyCode: order.specialtyCode,
          startDate: targetDate.toISOString(),
          // Look a week around the target date
          endDate: new Date(targetDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          duration: order.type === 'office_visit' ? 30 : 60,
        });

        if (slots.length > 0) {
          const appointment = await schedulingService.bookAppointment({
            patientId,
            slotId: slots[0].id,
            appointmentType: order.type,
            notes: `Post-discharge follow-up: ${order.reason}`,
            referenceEncounterId: ctx.state.input.encounterId,
          });

          followUps.push({
            type: order.type,
            appointmentId: appointment.id,
            scheduledDate: appointment.dateTime,
            providerName: appointment.providerName,
            status: 'scheduled',
          });
        } else {
          // No available slots - add to waitlist
          followUps.push({
            type: order.type,
            status: 'pending',
            notes: `No available slots near ${targetDate.toISOString().split('T')[0]}. Added to waitlist.`,
          });

          await schedulingService.addToWaitlist({
            patientId,
            appointmentType: order.type,
            preferredDate: targetDate.toISOString(),
            providerId: order.providerId,
            priority: order.priority,
            notes: `Post-discharge: ${order.reason}`,
          });
        }
      } catch (error: any) {
        followUps.push({
          type: order.type,
          status: 'failed',
          notes: `Failed to schedule: ${error.message}`,
        });

        ctx.state.errors.push({
          step: 'schedule_follow_ups',
          error: `Failed to schedule ${order.type}: ${error.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    ctx.state.followUpAppointments = followUps;

    logger.info('Follow-up scheduling complete', {
      action: 'FOLLOWUP_SCHEDULE_COMPLETE',
      patientId,
      scheduled: followUps.filter(f => f.status === 'scheduled').length,
      pending: followUps.filter(f => f.status === 'pending').length,
      failed: followUps.filter(f => f.status === 'failed').length,
    });
  },
};

function calculateTargetDate(dischargeDate: string, timeframe: string): Date {
  const discharge = new Date(dischargeDate);
  const match = timeframe.match(/(\d+)\s*(day|week|month)s?/i);

  if (!match) {
    // Default to 7 days if we can't parse the timeframe
    return new Date(discharge.getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'day':
      return new Date(discharge.getTime() + amount * 24 * 60 * 60 * 1000);
    case 'week':
      return new Date(discharge.getTime() + amount * 7 * 24 * 60 * 60 * 1000);
    case 'month':
      const result = new Date(discharge);
      result.setMonth(result.getMonth() + amount);
      return result;
    default:
      return new Date(discharge.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
}

// --- Step 3: Generate Care Instructions --------------------------------------

const generateCareInstructionsStep: WorkflowStep<DischargePlanningState> = {
  name: 'generate_care_instructions',
  timeout: 15000,
  retries: 1,

  async execute(ctx: WorkflowContext<DischargePlanningState>): Promise<void> {
    const { patientId, encounterId, dischargeDiagnoses, specialInstructions } = ctx.state.input;

    const documentService = new DocumentService();
    const patientService = new PatientService();

    // Get patient's preferred language for instructions
    const patient = await patientService.getPatient(patientId);
    const language = patient.preferredLanguage || 'en';

    logger.info('Generating discharge care instructions', {
      action: 'CARE_INSTRUCTIONS_GENERATE',
      patientId,
      language,
    });

    // Build the care instruction document
    const instructionData = {
      patientName: patient.fullName,
      dischargeDate: ctx.state.input.dischargeDate,
      diagnoses: dischargeDiagnoses,
      medications: ctx.state.medReconciliation?.currentMedications.filter(
        m => m.status !== 'discontinued'
      ) || [],
      discontinuedMedications: ctx.state.medReconciliation?.currentMedications.filter(
        m => m.status === 'discontinued'
      ) || [],
      followUpAppointments: ctx.state.followUpAppointments.filter(
        f => f.status === 'scheduled'
      ),
      pendingFollowUps: ctx.state.followUpAppointments.filter(
        f => f.status !== 'scheduled'
      ),
      specialInstructions,
      medicationWarnings: ctx.state.medReconciliation?.warnings || [],
      // Standard discharge instructions based on diagnosis
      // TODO: These should be condition-specific instruction templates
      // that the clinical team maintains. Right now they're generic.
      generalInstructions: [
        'Call 911 or go to the nearest emergency room if symptoms worsen suddenly',
        'Take all medications as directed',
        'Keep all scheduled follow-up appointments',
        'Contact your primary care provider with any questions',
      ],
      emergencyContact: '1-888-555-MERI',
    };

    const doc = await documentService.createDocument({
      type: 'discharge_instructions',
      patientId,
      encounterId,
      content: instructionData,
      format: 'pdf',
      language,
      metadata: {
        generatedAt: new Date().toISOString(),
        generatedBy: ctx.state.input.dischargedBy,
        diagnosisCount: dischargeDiagnoses.length,
        medicationCount: instructionData.medications.length,
      },
    });

    ctx.state.careInstructionsDocId = doc.id;

    // Also generate a patient-friendly summary if language is not English
    // TODO: Use a translation service. Currently we only have templates
    // in English and Spanish. Other languages get English only.
    if (language !== 'en' && language !== 'es') {
      logger.warn('Care instructions not available in patient preferred language', {
        action: 'CARE_INSTRUCTIONS_LANGUAGE_MISSING',
        patientId,
        requestedLanguage: language,
        availableLanguages: ['en', 'es'],
      });
    }

    logger.audit('Discharge care instructions generated', {
      action: 'PHI_CREATE',
      patientId,
      documentId: doc.id,
      userId: ctx.state.input.dischargedBy,
      resource: 'Document',
    });
  },
};

// --- Step 4: Notify PCP ------------------------------------------------------

const notifyPCPStep: WorkflowStep<DischargePlanningState> = {
  name: 'notify_pcp',
  timeout: 15000,
  retries: 2,

  async execute(ctx: WorkflowContext<DischargePlanningState>): Promise<void> {
    const { patientId, pcpId, encounterId, dischargeDisposition, attendingProviderId } = ctx.state.input;

    if (!pcpId) {
      logger.info('No PCP on file, skipping notification', {
        action: 'PCP_NOTIFY_SKIP',
        patientId,
      });
      ctx.state.pcpNotified = false;
      return;
    }

    // Don't notify PCP for AMA or expired dispositions through the normal channel
    if (dischargeDisposition === 'expired') {
      // Expired patients are handled by a separate notification process
      ctx.state.pcpNotified = false;
      return;
    }

    const notificationService = new NotificationService();

    try {
      await notificationService.send({
        recipientId: pcpId,
        channel: 'ehr_inbox',
        template: dischargeDisposition === 'ama'
          ? 'discharge_ama_notification'
          : 'discharge_notification',
        data: {
          patientId,
          encounterId,
          dischargeDate: ctx.state.input.dischargeDate,
          dischargeDisposition,
          diagnoses: ctx.state.input.dischargeDiagnoses,
          attendingProviderName: attendingProviderId, // This should be resolved to a name
          medicationChanges: ctx.state.medReconciliation?.currentMedications.filter(
            m => m.status !== 'continued'
          ),
          followUpAppointments: ctx.state.followUpAppointments,
          careInstructionsDocId: ctx.state.careInstructionsDocId,
          specialInstructions: ctx.state.input.specialInstructions,
        },
        priority: dischargeDisposition === 'ama' ? 'urgent' : 'high',
      });

      ctx.state.pcpNotified = true;

      logger.info('PCP notified of discharge', {
        action: 'PCP_NOTIFIED',
        patientId,
        pcpId,
        disposition: dischargeDisposition,
      });
    } catch (error: any) {
      ctx.state.pcpNotified = false;
      ctx.state.errors.push({
        step: 'notify_pcp',
        error: `Failed to notify PCP: ${error.message}`,
        timestamp: new Date().toISOString(),
      });

      // PCP notification failure is concerning but shouldn't block discharge
      logger.error('Failed to notify PCP of discharge', {
        action: 'PCP_NOTIFY_FAILED',
        patientId,
        pcpId,
        error: error.message,
      });
    }

    // Publish discharge event for other consumers
    const eventBus = new EventBus();
    await eventBus.publish('patient.discharged', {
      patientId,
      encounterId,
      dischargeDate: ctx.state.input.dischargeDate,
      dischargeDisposition,
      pcpNotified: ctx.state.pcpNotified,
      followUpCount: ctx.state.followUpAppointments.length,
      timestamp: new Date().toISOString(),
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const dischargePlanningWorkflow = new WorkflowEngine<
  DischargePlanningInput,
  DischargePlanningState
>({
  name: 'discharge_planning',
  version: '2.0.0',
  description: 'Manages the discharge process including med rec, follow-ups, and PCP notification',

  initialState: (input: DischargePlanningInput): DischargePlanningState => ({
    input,
    followUpAppointments: [],
    pcpNotified: false,
    errors: [],
  }),

  steps: [
    medicationReconciliationStep,
    scheduleFollowUpsStep,
    generateCareInstructionsStep,
    notifyPCPStep,
  ],

  criticalSteps: ['medication_reconciliation', 'generate_care_instructions'],
  bestEffortSteps: ['schedule_follow_ups', 'notify_pcp'],

  hooks: {
    onComplete: async (ctx) => {
      logger.info('Discharge planning workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        patientId: ctx.state.input.patientId,
        encounterId: ctx.state.input.encounterId,
        disposition: ctx.state.input.dischargeDisposition,
        medReconciled: !!ctx.state.medReconciliation,
        followUpsScheduled: ctx.state.followUpAppointments.filter(f => f.status === 'scheduled').length,
        pcpNotified: ctx.state.pcpNotified,
        duration: ctx.duration,
      });
    },
  },
});

export type { DischargePlanningInput, DischargePlanningState };
