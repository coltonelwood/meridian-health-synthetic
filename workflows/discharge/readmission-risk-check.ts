/**
 * Readmission Risk Check
 *
 * Evaluates a patient's risk of readmission within 30 days using a
 * combination of clinical rules and an ML model. High-risk patients
 * trigger additional interventions (care management enrollment, more
 * frequent follow-ups, etc.).
 *
 * This runs as part of the discharge workflow but can also be triggered
 * independently by case management.
 *
 * The ML model (LACE+ variant) was trained on our own historical data.
 * Current AUROC: 0.74 (validated Q4 2025). Not great, not terrible.
 *
 * Owner: Care Transitions team + Data Science team
 * CMS Penalty Context: Hospital Readmissions Reduction Program (HRRP)
 * penalizes us for excess readmissions for AMI, HF, pneumonia, COPD,
 * hip/knee replacement, and CABG.
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { PatientService } from '@meridian/patient-service-client';
import { RiskModelClient } from '@meridian/risk-model-client';
import { CareManagementService } from '@meridian/care-management-client';
import { SchedulingService } from '@meridian/scheduling-client';
import { NotificationService } from '@meridian/notification-service';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';

const logger = new HIPAALogger({ service: 'readmission-risk-check' });

// --- Types -------------------------------------------------------------------

interface ReadmissionRiskInput {
  patientId: string;
  encounterId: string;
  dischargeDiagnoses: string[];
  lengthOfStay: number; // days
  attendingProviderId: string;
  dischargeDisposition: string;
  hasEdVisitLast6Months: boolean;
  admissionCount12Months: number;
  // Social determinants - these significantly impact readmission risk
  livesAlone: boolean | null; // null = unknown
  hasTransportation: boolean | null;
  hasCaregiverSupport: boolean | null;
  primaryLanguage: string;
  healthLiteracy: 'low' | 'moderate' | 'high' | 'unknown';
}

interface ReadmissionRiskState {
  input: ReadmissionRiskInput;
  riskScore?: RiskScore;
  interventions: Intervention[];
  careManagementEnrolled: boolean;
  additionalFollowUpsScheduled: number;
  errors: { step: string; error: string; timestamp: string }[];
}

interface RiskScore {
  score: number; // 0-100
  riskLevel: 'low' | 'moderate' | 'high' | 'critical';
  factors: RiskFactor[];
  modelVersion: string;
  calculatedAt: string;
  // LACE components for the rules-based portion
  laceScore: {
    lengthOfStay: number; // L: 0-7
    acuityOfAdmission: number; // A: 0-3
    comorbidities: number; // C: 0-6 (Charlson index)
    edVisits: number; // E: 0-4
    total: number;
  };
}

interface RiskFactor {
  factor: string;
  impact: 'positive' | 'negative'; // positive = increases risk
  weight: number;
  description: string;
}

interface Intervention {
  type: InterventionType;
  description: string;
  assignedTo: string;
  status: 'ordered' | 'pending' | 'completed' | 'declined';
  priority: 'routine' | 'urgent';
}

type InterventionType =
  | 'care_management_enrollment'
  | 'follow_up_call_24h'
  | 'follow_up_call_72h'
  | 'additional_follow_up_visit'
  | 'medication_therapy_management'
  | 'social_work_referral'
  | 'home_health_referral'
  | 'pharmacy_consultation'
  | 'transportation_assistance'
  | 'language_services';

// --- Step 1: Calculate Risk Score --------------------------------------------

const calculateRiskScoreStep: WorkflowStep<ReadmissionRiskState> = {
  name: 'calculate_risk_score',
  timeout: 15000,
  retries: 2,

  async execute(ctx: WorkflowContext<ReadmissionRiskState>): Promise<void> {
    const input = ctx.state.input;

    logger.info('Calculating readmission risk score', {
      action: 'RISK_SCORE_START',
      patientId: input.patientId,
      encounterId: input.encounterId,
    });

    // Calculate LACE score (rules-based component)
    const laceScore = calculateLACE(input);

    // Call the ML model for a more nuanced prediction
    const riskModelClient = new RiskModelClient();
    let mlPrediction: number;

    try {
      const modelResult = await riskModelClient.predict({
        modelId: 'readmission-risk-v3',
        features: {
          length_of_stay: input.lengthOfStay,
          admission_count_12m: input.admissionCount12Months,
          ed_visit_6m: input.hasEdVisitLast6Months ? 1 : 0,
          lives_alone: input.livesAlone === null ? -1 : (input.livesAlone ? 1 : 0),
          has_transportation: input.hasTransportation === null ? -1 : (input.hasTransportation ? 1 : 0),
          has_caregiver: input.hasCaregiverSupport === null ? -1 : (input.hasCaregiverSupport ? 1 : 0),
          primary_language_english: input.primaryLanguage === 'en' ? 1 : 0,
          health_literacy_low: input.healthLiteracy === 'low' ? 1 : 0,
          diagnosis_codes: input.dischargeDiagnoses,
          discharge_disposition: input.dischargeDisposition,
        },
      });

      mlPrediction = modelResult.probability;
    } catch (error: any) {
      // If the ML model fails, fall back to LACE score only
      // This happened twice in production (model service was down)
      logger.warn('ML risk model unavailable, using LACE score only', {
        action: 'RISK_MODEL_FALLBACK',
        error: error.message,
      });
      mlPrediction = laceScore.total / 19; // Normalize LACE to 0-1
    }

    // Combine LACE and ML scores (weighted average)
    // The ML model is better overall but LACE is more interpretable
    // and required for some reporting purposes
    const combinedScore = Math.round(
      (mlPrediction * 0.65 + (laceScore.total / 19) * 0.35) * 100
    );

    // Determine risk level
    let riskLevel: 'low' | 'moderate' | 'high' | 'critical';
    if (combinedScore >= 75) riskLevel = 'critical';
    else if (combinedScore >= 50) riskLevel = 'high';
    else if (combinedScore >= 25) riskLevel = 'moderate';
    else riskLevel = 'low';

    // Identify key risk factors
    const factors: RiskFactor[] = [];

    if (input.admissionCount12Months >= 2) {
      factors.push({
        factor: 'frequent_admissions',
        impact: 'positive',
        weight: 0.3,
        description: `${input.admissionCount12Months} admissions in past 12 months`,
      });
    }

    if (input.lengthOfStay >= 7) {
      factors.push({
        factor: 'long_stay',
        impact: 'positive',
        weight: 0.2,
        description: `Length of stay: ${input.lengthOfStay} days`,
      });
    }

    if (input.livesAlone === true) {
      factors.push({
        factor: 'lives_alone',
        impact: 'positive',
        weight: 0.15,
        description: 'Patient lives alone',
      });
    }

    if (input.healthLiteracy === 'low') {
      factors.push({
        factor: 'low_health_literacy',
        impact: 'positive',
        weight: 0.15,
        description: 'Low health literacy may affect medication adherence',
      });
    }

    if (input.hasEdVisitLast6Months) {
      factors.push({
        factor: 'recent_ed_visit',
        impact: 'positive',
        weight: 0.1,
        description: 'ED visit in past 6 months',
      });
    }

    if (input.hasCaregiverSupport === true) {
      factors.push({
        factor: 'caregiver_support',
        impact: 'negative',
        weight: -0.1,
        description: 'Has caregiver support at home',
      });
    }

    // CMS penalty conditions get extra weight
    const cmsPenaltyConditions = ['I21', 'I50', 'J18', 'J44', 'M17', 'Z96.64'];
    const hasCMSCondition = input.dischargeDiagnoses.some(
      dx => cmsPenaltyConditions.some(c => dx.startsWith(c))
    );

    if (hasCMSCondition) {
      factors.push({
        factor: 'cms_penalty_condition',
        impact: 'positive',
        weight: 0.2,
        description: 'Diagnosis is in CMS Hospital Readmissions Reduction Program',
      });
    }

    ctx.state.riskScore = {
      score: combinedScore,
      riskLevel,
      factors,
      modelVersion: 'readmission-risk-v3+lace',
      calculatedAt: new Date().toISOString(),
      laceScore,
    };

    logger.info('Readmission risk score calculated', {
      action: 'RISK_SCORE_COMPLETE',
      patientId: input.patientId,
      score: combinedScore,
      riskLevel,
      laceTotal: laceScore.total,
      factorCount: factors.length,
    });
  },
};

function calculateLACE(input: ReadmissionRiskInput): {
  lengthOfStay: number;
  acuityOfAdmission: number;
  comorbidities: number;
  edVisits: number;
  total: number;
} {
  // LACE Index scoring
  // L: Length of stay
  let los = 0;
  if (input.lengthOfStay === 1) los = 1;
  else if (input.lengthOfStay === 2) los = 2;
  else if (input.lengthOfStay === 3) los = 3;
  else if (input.lengthOfStay >= 4 && input.lengthOfStay <= 6) los = 4;
  else if (input.lengthOfStay >= 7 && input.lengthOfStay <= 13) los = 5;
  else if (input.lengthOfStay >= 14) los = 7;

  // A: Acuity (simplified - we don't have admission type in the input)
  // TODO: Pass admission type (emergent vs elective) into the workflow
  const acuity = 3; // Assume emergent for now, which is the conservative choice

  // C: Comorbidities (Charlson index - simplified)
  // In reality we'd calculate this from the full diagnosis list
  // For now, approximate based on diagnosis count
  const comorbidities = Math.min(6, Math.floor(input.dischargeDiagnoses.length / 2));

  // E: ED visits in past 6 months
  let edScore = 0;
  if (input.hasEdVisitLast6Months) {
    edScore = Math.min(4, input.admissionCount12Months); // Rough approximation
  }

  return {
    lengthOfStay: los,
    acuityOfAdmission: acuity,
    comorbidities,
    edVisits: edScore,
    total: los + acuity + comorbidities + edScore,
  };
}

// --- Step 2: Determine Interventions -----------------------------------------

const determineInterventionsStep: WorkflowStep<ReadmissionRiskState> = {
  name: 'determine_interventions',
  timeout: 10000,
  retries: 0,

  async execute(ctx: WorkflowContext<ReadmissionRiskState>): Promise<void> {
    if (!ctx.state.riskScore) {
      throw new Error('Risk score not calculated');
    }

    const { riskLevel, score, factors } = ctx.state.riskScore;
    const input = ctx.state.input;
    const interventions: Intervention[] = [];

    // All high/critical risk patients get these
    if (riskLevel === 'high' || riskLevel === 'critical') {
      interventions.push({
        type: 'care_management_enrollment',
        description: 'Enroll in transitional care management program',
        assignedTo: 'care_management_team',
        status: 'ordered',
        priority: 'urgent',
      });

      interventions.push({
        type: 'follow_up_call_24h',
        description: 'Post-discharge phone call within 24 hours',
        assignedTo: 'care_coordinator',
        status: 'ordered',
        priority: 'urgent',
      });

      interventions.push({
        type: 'follow_up_call_72h',
        description: 'Follow-up phone call within 72 hours',
        assignedTo: 'care_coordinator',
        status: 'ordered',
        priority: 'routine',
      });

      interventions.push({
        type: 'medication_therapy_management',
        description: 'Pharmacist medication review within 7 days',
        assignedTo: 'pharmacy_team',
        status: 'ordered',
        priority: 'routine',
      });
    }

    // Critical risk gets additional interventions
    if (riskLevel === 'critical') {
      interventions.push({
        type: 'additional_follow_up_visit',
        description: 'Schedule additional follow-up visit within 48 hours',
        assignedTo: 'scheduling',
        status: 'ordered',
        priority: 'urgent',
      });
    }

    // Social determinant-based interventions
    if (input.livesAlone === true || input.hasCaregiverSupport === false) {
      interventions.push({
        type: 'social_work_referral',
        description: 'Social work assessment for home support needs',
        assignedTo: 'social_work',
        status: 'ordered',
        priority: riskLevel === 'critical' ? 'urgent' : 'routine',
      });
    }

    if (input.hasTransportation === false) {
      interventions.push({
        type: 'transportation_assistance',
        description: 'Arrange transportation for follow-up appointments',
        assignedTo: 'patient_access',
        status: 'ordered',
        priority: 'routine',
      });
    }

    if (input.primaryLanguage !== 'en') {
      interventions.push({
        type: 'language_services',
        description: `Ensure follow-up materials and calls in ${input.primaryLanguage}`,
        assignedTo: 'language_services',
        status: 'ordered',
        priority: 'routine',
      });
    }

    // Moderate risk gets a subset
    if (riskLevel === 'moderate') {
      interventions.push({
        type: 'follow_up_call_72h',
        description: 'Post-discharge phone call within 72 hours',
        assignedTo: 'care_coordinator',
        status: 'ordered',
        priority: 'routine',
      });
    }

    ctx.state.interventions = interventions;

    logger.info('Readmission interventions determined', {
      action: 'INTERVENTIONS_DETERMINED',
      patientId: input.patientId,
      riskLevel,
      score,
      interventionCount: interventions.length,
    });
  },
};

// --- Step 3: Execute Interventions -------------------------------------------

const executeInterventionsStep: WorkflowStep<ReadmissionRiskState> = {
  name: 'execute_interventions',
  timeout: 30000,
  retries: 1,

  async execute(ctx: WorkflowContext<ReadmissionRiskState>): Promise<void> {
    if (ctx.state.interventions.length === 0) {
      logger.info('No interventions needed', {
        action: 'INTERVENTIONS_NONE',
        patientId: ctx.state.input.patientId,
      });
      return;
    }

    const careManagement = new CareManagementService();
    const schedulingService = new SchedulingService();
    const notificationService = new NotificationService();
    const eventBus = new EventBus();

    for (const intervention of ctx.state.interventions) {
      try {
        switch (intervention.type) {
          case 'care_management_enrollment': {
            await careManagement.enrollPatient({
              patientId: ctx.state.input.patientId,
              programType: 'transitional_care',
              riskScore: ctx.state.riskScore!.score,
              riskLevel: ctx.state.riskScore!.riskLevel,
              encounterId: ctx.state.input.encounterId,
              enrolledBy: 'system',
            });
            ctx.state.careManagementEnrolled = true;
            intervention.status = 'completed';
            break;
          }

          case 'follow_up_call_24h':
          case 'follow_up_call_72h': {
            const hoursDelay = intervention.type === 'follow_up_call_24h' ? 24 : 72;
            await notificationService.scheduleCall({
              patientId: ctx.state.input.patientId,
              callType: 'post_discharge_follow_up',
              scheduledFor: new Date(
                Date.now() + hoursDelay * 60 * 60 * 1000
              ).toISOString(),
              assignedTo: intervention.assignedTo,
              script: 'post_discharge_check_in',
              priority: intervention.priority,
            });
            intervention.status = 'completed';
            break;
          }

          case 'additional_follow_up_visit': {
            const slots = await schedulingService.findAvailableSlots({
              appointmentType: 'post_discharge',
              startDate: new Date().toISOString(),
              endDate: new Date(
                Date.now() + 48 * 60 * 60 * 1000
              ).toISOString(),
              duration: 30,
            });

            if (slots.length > 0) {
              await schedulingService.bookAppointment({
                patientId: ctx.state.input.patientId,
                slotId: slots[0].id,
                appointmentType: 'post_discharge',
                notes: 'High readmission risk - additional follow-up',
              });
              ctx.state.additionalFollowUpsScheduled++;
              intervention.status = 'completed';
            } else {
              intervention.status = 'pending';
              intervention.description += ' (no slots available - manual scheduling needed)';
            }
            break;
          }

          default: {
            // Other interventions are notifications to the appropriate team
            await eventBus.publish('intervention.ordered', {
              patientId: ctx.state.input.patientId,
              encounterId: ctx.state.input.encounterId,
              interventionType: intervention.type,
              assignedTo: intervention.assignedTo,
              priority: intervention.priority,
              description: intervention.description,
            });
            intervention.status = 'pending'; // requires human action
            break;
          }
        }
      } catch (error: any) {
        intervention.status = 'pending';
        ctx.state.errors.push({
          step: 'execute_interventions',
          error: `Failed to execute ${intervention.type}: ${error.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    logger.info('Readmission interventions executed', {
      action: 'INTERVENTIONS_EXECUTED',
      patientId: ctx.state.input.patientId,
      completed: ctx.state.interventions.filter(i => i.status === 'completed').length,
      pending: ctx.state.interventions.filter(i => i.status === 'pending').length,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const readmissionRiskCheckWorkflow = new WorkflowEngine<
  ReadmissionRiskInput,
  ReadmissionRiskState
>({
  name: 'readmission_risk_check',
  version: '2.2.0',
  description: 'Evaluates readmission risk and triggers interventions for high-risk patients',

  initialState: (input: ReadmissionRiskInput): ReadmissionRiskState => ({
    input,
    interventions: [],
    careManagementEnrolled: false,
    additionalFollowUpsScheduled: 0,
    errors: [],
  }),

  steps: [
    calculateRiskScoreStep,
    determineInterventionsStep,
    executeInterventionsStep,
  ],

  criticalSteps: ['calculate_risk_score'],
  bestEffortSteps: ['execute_interventions'],

  hooks: {
    onComplete: async (ctx) => {
      logger.info('Readmission risk check workflow completed', {
        action: 'WORKFLOW_COMPLETE',
        patientId: ctx.state.input.patientId,
        riskScore: ctx.state.riskScore?.score,
        riskLevel: ctx.state.riskScore?.riskLevel,
        interventionCount: ctx.state.interventions.length,
        duration: ctx.duration,
      });
    },
  },
});

export type { ReadmissionRiskInput, ReadmissionRiskState, RiskScore };
