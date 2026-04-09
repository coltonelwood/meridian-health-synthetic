/**
 * Referral Tracking Workflow
 *
 * Monitors active referrals for status updates, sends follow-up reminders,
 * and tracks completion. This is a long-running workflow that persists until
 * the referral is completed, expired, or canceled.
 *
 * Runs on a schedule - checks each active referral daily.
 *
 * Owner: Care Coordination team
 */

import { WorkflowEngine, WorkflowStep, WorkflowContext } from '@meridian/workflow-engine';
import { ReferralService, Referral, ReferralStatus } from '@meridian/referral-service-client';
import { AppointmentService } from '@meridian/scheduling-client';
import { NotificationService } from '@meridian/notification-service';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { EventBus } from '@meridian/event-bus';

const logger = new HIPAALogger({ service: 'track-referral-workflow' });

// --- Types -------------------------------------------------------------------

interface TrackReferralInput {
  referralId: string;
  patientId: string;
  referredToProviderId: string;
  referringProviderId: string;
  validToDate: string;
  numberOfVisits: number;
}

interface TrackReferralState {
  input: TrackReferralInput;
  referral?: Referral;
  visitsCompleted: number;
  lastStatusCheck: string;
  remindersent: ReminderRecord[];
  isComplete: boolean;
  completionReason?: 'all_visits_used' | 'expired' | 'canceled' | 'patient_request';
}

interface ReminderRecord {
  type: 'patient_schedule' | 'provider_follow_up' | 'expiration_warning' | 'completion_report';
  sentAt: string;
  recipient: string;
}

// --- Step 1: Check Status Updates --------------------------------------------

const checkStatusStep: WorkflowStep<TrackReferralState> = {
  name: 'check_status',
  timeout: 10000,
  retries: 2,

  async execute(ctx: WorkflowContext<TrackReferralState>): Promise<void> {
    const referralService = new ReferralService();
    const appointmentService = new AppointmentService();

    const referral = await referralService.getReferral(ctx.state.input.referralId);

    if (!referral) {
      ctx.state.isComplete = true;
      ctx.state.completionReason = 'canceled';
      return;
    }

    ctx.state.referral = referral;
    ctx.state.lastStatusCheck = new Date().toISOString();

    // Check how many visits have been completed
    const appointments = await appointmentService.getAppointments({
      patientId: ctx.state.input.patientId,
      providerId: ctx.state.input.referredToProviderId,
      referralId: ctx.state.input.referralId,
      status: 'completed',
    });

    ctx.state.visitsCompleted = appointments.length;

    // Check if referral is complete
    if (ctx.state.visitsCompleted >= ctx.state.input.numberOfVisits) {
      ctx.state.isComplete = true;
      ctx.state.completionReason = 'all_visits_used';
    } else if (new Date(ctx.state.input.validToDate) < new Date()) {
      ctx.state.isComplete = true;
      ctx.state.completionReason = 'expired';
    } else if (referral.status === 'canceled') {
      ctx.state.isComplete = true;
      ctx.state.completionReason = 'canceled';
    }

    logger.info('Referral status checked', {
      action: 'REFERRAL_STATUS_CHECK',
      referralId: ctx.state.input.referralId,
      visitsCompleted: ctx.state.visitsCompleted,
      totalVisits: ctx.state.input.numberOfVisits,
      isComplete: ctx.state.isComplete,
    });
  },
};

// --- Step 2: Send Follow-up Reminders ----------------------------------------

const sendRemindersStep: WorkflowStep<TrackReferralState> = {
  name: 'send_reminders',
  timeout: 15000,
  retries: 1,

  async execute(ctx: WorkflowContext<TrackReferralState>): Promise<void> {
    if (ctx.state.isComplete) return;

    const notificationService = new NotificationService();
    const appointmentService = new AppointmentService();

    // Check if patient has any upcoming appointments for this referral
    const upcomingAppointments = await appointmentService.getAppointments({
      patientId: ctx.state.input.patientId,
      providerId: ctx.state.input.referredToProviderId,
      referralId: ctx.state.input.referralId,
      status: 'scheduled',
      fromDate: new Date().toISOString(),
    });

    // If no upcoming appointments and visits remain, remind patient to schedule
    if (upcomingAppointments.length === 0 &&
        ctx.state.visitsCompleted < ctx.state.input.numberOfVisits) {

      // Don't spam - only send reminder if we haven't sent one in the last 7 days
      const lastPatientReminder = ctx.state.remindersent
        .filter(r => r.type === 'patient_schedule')
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0];

      const daysSinceLastReminder = lastPatientReminder
        ? Math.floor((Date.now() - new Date(lastPatientReminder.sentAt).getTime()) / (1000 * 60 * 60 * 24))
        : Infinity;

      if (daysSinceLastReminder >= 7) {
        await notificationService.send({
          recipientId: ctx.state.input.patientId,
          channel: 'portal',
          template: 'referral_schedule_reminder',
          data: {
            referralId: ctx.state.input.referralId,
            specialtyName: ctx.state.referral?.specialtyDescription,
            visitsRemaining: ctx.state.input.numberOfVisits - ctx.state.visitsCompleted,
            expirationDate: ctx.state.input.validToDate,
          },
          priority: 'normal',
        });

        ctx.state.remindersent.push({
          type: 'patient_schedule',
          sentAt: new Date().toISOString(),
          recipient: ctx.state.input.patientId,
        });
      }
    }

    // Check if referral is expiring soon (within 14 days)
    const daysUntilExpiration = Math.floor(
      (new Date(ctx.state.input.validToDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    if (daysUntilExpiration <= 14 && daysUntilExpiration > 0) {
      const lastExpirationWarning = ctx.state.remindersent
        .filter(r => r.type === 'expiration_warning')
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0];

      if (!lastExpirationWarning) {
        // Notify both patient and referring provider
        await notificationService.send({
          recipientId: ctx.state.input.patientId,
          channel: 'portal',
          template: 'referral_expiring',
          data: {
            referralId: ctx.state.input.referralId,
            daysRemaining: daysUntilExpiration,
            visitsRemaining: ctx.state.input.numberOfVisits - ctx.state.visitsCompleted,
          },
          priority: 'high',
        });

        await notificationService.send({
          recipientId: ctx.state.input.referringProviderId,
          channel: 'ehr_inbox',
          template: 'referral_expiring_provider',
          data: {
            referralId: ctx.state.input.referralId,
            patientId: ctx.state.input.patientId,
            daysRemaining: daysUntilExpiration,
            visitsUsed: ctx.state.visitsCompleted,
            totalVisits: ctx.state.input.numberOfVisits,
          },
          priority: 'normal',
        });

        ctx.state.remindersent.push({
          type: 'expiration_warning',
          sentAt: new Date().toISOString(),
          recipient: ctx.state.input.patientId,
        });
      }
    }
  },
};

// --- Step 3: Track Completion ------------------------------------------------

const trackCompletionStep: WorkflowStep<TrackReferralState> = {
  name: 'track_completion',
  timeout: 10000,
  retries: 1,

  async execute(ctx: WorkflowContext<TrackReferralState>): Promise<void> {
    if (!ctx.state.isComplete) {
      // Schedule next check for tomorrow
      await ctx.scheduleEvent('referral_daily_check', {
        scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        data: { referralId: ctx.state.input.referralId },
      });
      return;
    }

    // Referral is complete - update status and notify
    const referralService = new ReferralService();
    const notificationService = new NotificationService();
    const eventBus = new EventBus();

    await referralService.updateReferral(ctx.state.input.referralId, {
      status: ctx.state.completionReason === 'all_visits_used' ? 'completed' : ctx.state.completionReason as ReferralStatus,
      visitsCompleted: ctx.state.visitsCompleted,
      completedAt: new Date().toISOString(),
    });

    // Send completion report to referring provider
    await notificationService.send({
      recipientId: ctx.state.input.referringProviderId,
      channel: 'ehr_inbox',
      template: 'referral_completed',
      data: {
        referralId: ctx.state.input.referralId,
        patientId: ctx.state.input.patientId,
        visitsCompleted: ctx.state.visitsCompleted,
        totalVisits: ctx.state.input.numberOfVisits,
        completionReason: ctx.state.completionReason,
      },
      priority: 'normal',
    });

    ctx.state.remindersent.push({
      type: 'completion_report',
      sentAt: new Date().toISOString(),
      recipient: ctx.state.input.referringProviderId,
    });

    await eventBus.publish('referral.completed', {
      referralId: ctx.state.input.referralId,
      patientId: ctx.state.input.patientId,
      completionReason: ctx.state.completionReason,
      visitsCompleted: ctx.state.visitsCompleted,
    });

    logger.info('Referral tracking complete', {
      action: 'REFERRAL_TRACKING_COMPLETE',
      referralId: ctx.state.input.referralId,
      completionReason: ctx.state.completionReason,
      visitsCompleted: ctx.state.visitsCompleted,
    });
  },
};

// --- Workflow Definition -----------------------------------------------------

export const trackReferralWorkflow = new WorkflowEngine<TrackReferralInput, TrackReferralState>({
  name: 'track_referral',
  version: '1.2.0',
  description: 'Monitors referral status, sends reminders, and tracks completion',

  initialState: (input: TrackReferralInput): TrackReferralState => ({
    input,
    visitsCompleted: 0,
    lastStatusCheck: new Date().toISOString(),
    remindersent: [],
    isComplete: false,
  }),

  steps: [
    checkStatusStep,
    sendRemindersStep,
    trackCompletionStep,
  ],

  criticalSteps: ['check_status'],
  bestEffortSteps: ['send_reminders'],
});

export type { TrackReferralInput, TrackReferralState };
