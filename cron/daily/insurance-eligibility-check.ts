/**
 * Daily Insurance Eligibility Check
 *
 * Runs eligibility verification (EDI 270/271) for patients with
 * appointments in the next 3 business days. Flags patients with
 * lapsed or changed coverage so front desk can follow up.
 *
 * Schedule: 0 5 * * 1-5 (5 AM ET, weekdays only)
 * Timeout: 45 minutes
 * Owner: Revenue Cycle Team
 */

import { CronJob } from '../lib/cron-job';
import { AppointmentsRepository } from '../repositories/appointments';
import { PatientsRepository } from '../repositories/patients';
import { EligibilityClient } from '../clients/eligibility';
import { SlackNotifier } from '../lib/slack';
import { EmailService } from '../lib/email';
import { AuditLogger } from '../lib/audit';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';
import { addBusinessDays, format } from 'date-fns';

interface EligibilityResult {
  patientId: string;
  patientMrn: string;
  patientName: string;
  appointmentId: string;
  appointmentDate: string;
  providerName: string;
  payerId: string;
  payerName: string;
  status: 'active' | 'inactive' | 'changed' | 'error';
  details?: string;
  copayAmount?: number;
  deductibleRemaining?: number;
}

const LOOKAHEAD_BUSINESS_DAYS = 3;
const RATE_LIMIT_MS = 500; // Availity rate limits to 120 requests/minute

const job = new CronJob({
  name: 'insurance-eligibility-check',
  schedule: '0 5 * * 1-5',
  timezone: 'America/New_York',
  timeout: 45 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const appointmentsRepo = new AppointmentsRepository();
  const patientsRepo = new PatientsRepository();
  const eligibility = new EligibilityClient();
  const slack = new SlackNotifier('#front-desk-alerts');
  const email = new EmailService();
  const audit = new AuditLogger('eligibility-check');

  const startTime = Date.now();
  const today = new Date();
  const checkUntil = addBusinessDays(today, LOOKAHEAD_BUSINESS_DAYS);

  const results = {
    total: 0,
    active: 0,
    inactive: 0,
    changed: 0,
    errors: 0,
    flagged: [] as EligibilityResult[],
  };

  logger.info(`Starting eligibility check for appointments ${format(today, 'yyyy-MM-dd')} to ${format(checkUntil, 'yyyy-MM-dd')}`);

  try {
    // Get upcoming appointments that haven't been verified yet
    const appointments = await appointmentsRepo.findUpcoming({
      from: today,
      to: checkUntil,
      statuses: ['confirmed', 'requested'],
      insuranceVerified: false,
      excludeCancelled: true,
    });

    results.total = appointments.length;
    logger.info(`Found ${results.total} appointments needing eligibility verification`);

    for (const appointment of appointments) {
      try {
        // Get patient's current insurance info
        const patient = await patientsRepo.findById(appointment.patientId);
        if (!patient || !patient.insurance?.primary) {
          logger.warn(`Patient ${appointment.patientId} has no primary insurance on file`);
          results.errors++;
          continue;
        }

        const insurance = patient.insurance.primary;

        // Skip self-pay patients
        if (insurance.payerId === 'SELF') {
          await appointmentsRepo.updateInsuranceVerification(appointment.id, {
            verified: true,
            verifiedAt: new Date(),
            verifiedBy: 'cron:eligibility-check',
            status: 'self_pay',
          });
          continue;
        }

        // Rate limit
        await sleep(RATE_LIMIT_MS);

        // Run eligibility check (270/271 transaction)
        const eligibilityResponse = await eligibility.verify({
          payerId: insurance.payerId,
          memberId: insurance.memberId,
          subscriberName: insurance.subscriberName,
          patientFirstName: patient.firstName,
          patientLastName: patient.lastName,
          patientDob: patient.dateOfBirth,
          serviceType: mapAppointmentTypeToServiceType(appointment.appointmentType.code),
          serviceDate: appointment.startTime,
          providerNpi: appointment.providerNpi,
        });

        const result: EligibilityResult = {
          patientId: patient.id,
          patientMrn: patient.mrn,
          patientName: `${patient.firstName} ${patient.lastName}`,
          appointmentId: appointment.id,
          appointmentDate: format(new Date(appointment.startTime), 'MM/dd/yyyy h:mm a'),
          providerName: appointment.providerName,
          payerId: insurance.payerId,
          payerName: insurance.payerName,
          status: 'active',
          copayAmount: eligibilityResponse.copay,
          deductibleRemaining: eligibilityResponse.deductibleRemaining,
        };

        if (!eligibilityResponse.isActive) {
          result.status = 'inactive';
          result.details = eligibilityResponse.inactiveReason || 'Coverage inactive or terminated';
          results.inactive++;
          results.flagged.push(result);
        } else if (eligibilityResponse.planChanged) {
          result.status = 'changed';
          result.details = `Plan changed from ${insurance.planName} to ${eligibilityResponse.currentPlanName}`;
          results.changed++;
          results.flagged.push(result);
        } else {
          result.status = 'active';
          results.active++;
        }

        // Update appointment with verification results
        await appointmentsRepo.updateInsuranceVerification(appointment.id, {
          verified: true,
          verifiedAt: new Date(),
          verifiedBy: 'cron:eligibility-check',
          status: result.status,
          copayAmount: eligibilityResponse.copay,
          deductibleRemaining: eligibilityResponse.deductibleRemaining,
          coinsurancePercent: eligibilityResponse.coinsurancePercent,
          eligibilityResponse: eligibilityResponse.rawResponse,
        });

        // Audit log
        await audit.log({
          action: 'ELIGIBILITY_VERIFIED',
          resourceType: 'appointment',
          resourceId: appointment.id,
          patientId: patient.id,
          details: {
            status: result.status,
            payerId: insurance.payerId,
          },
        });

      } catch (error) {
        results.errors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Eligibility check failed for appointment ${appointment.id}: ${errorMessage}`);
      }
    }

    // Notify front desk about flagged patients
    if (results.flagged.length > 0) {
      const inactivePatients = results.flagged.filter(r => r.status === 'inactive');
      const changedPatients = results.flagged.filter(r => r.status === 'changed');

      let message = '*Insurance Eligibility Alerts*\n\n';

      if (inactivePatients.length > 0) {
        message += '*INACTIVE COVERAGE:*\n';
        for (const p of inactivePatients) {
          message += `- ${p.patientName} (${p.patientMrn}) - ${p.appointmentDate} with ${p.providerName}\n`;
          message += `  Payer: ${p.payerName} | Reason: ${p.details}\n`;
        }
        message += '\n';
      }

      if (changedPatients.length > 0) {
        message += '*PLAN CHANGES DETECTED:*\n';
        for (const p of changedPatients) {
          message += `- ${p.patientName} (${p.patientMrn}) - ${p.appointmentDate} with ${p.providerName}\n`;
          message += `  ${p.details}\n`;
        }
      }

      await slack.send(message);

      // Also email the front desk distribution list
      await email.send({
        to: 'frontdesk-alerts@meridianhealth.io',
        subject: `[Action Required] ${results.flagged.length} Insurance Eligibility Alerts`,
        template: 'eligibility-alert',
        data: {
          inactivePatients,
          changedPatients,
          date: format(today, 'MMMM d, yyyy'),
        },
      });
    }

    // Summary metrics
    const duration = Math.round((Date.now() - startTime) / 1000);

    metrics.gauge('cron.eligibility_check.total', results.total);
    metrics.gauge('cron.eligibility_check.active', results.active);
    metrics.gauge('cron.eligibility_check.inactive', results.inactive);
    metrics.gauge('cron.eligibility_check.changed', results.changed);
    metrics.gauge('cron.eligibility_check.errors', results.errors);
    metrics.timing('cron.eligibility_check.duration', Date.now() - startTime);

    logger.info(`Eligibility check complete in ${duration}s`, results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Fatal error in eligibility check: ${errorMessage}`);
    await slack.sendUrgent(`Eligibility check FAILED: ${errorMessage}`);
    throw error;
  }
});

function mapAppointmentTypeToServiceType(code: string): string {
  const mapping: Record<string, string> = {
    'NEW': '30',    // Health benefit plan coverage
    'FU': '30',
    'ANNUAL': '30',
    'URGENT': '30',
    'TELE': '30',
    'CONSULT': '30',
  };
  return mapping[code] || '30';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default job;
