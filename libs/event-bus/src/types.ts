/**
 * Domain event type definitions.
 *
 * All events in the system should be defined here for discoverability.
 * Events use a dot-notation naming convention: {domain}.{action}
 *
 * IMPORTANT: Events should NOT contain PHI directly.
 * Use resource IDs and let the consumer fetch full data from the source.
 */

export interface DomainEvent {
  [key: string]: any;
}

export interface EventMetadata {
  eventId: string;
  eventType: string;
  timestamp: string;
  source: string;
  correlationId: string;
}

// --- Patient Events ----------------------------------------------------------

export interface PatientCreatedEvent extends DomainEvent {
  patientId: string;
  mrn: string;
  source: 'portal' | 'ehr_import' | 'call_center' | 'kiosk';
  timestamp: string;
}

export interface PatientUpdatedEvent extends DomainEvent {
  patientId: string;
  updatedFields: string[];
  updatedBy: string;
  timestamp: string;
}

export interface PatientMergedEvent extends DomainEvent {
  survivingPatientId: string;
  mergedPatientId: string;
  mergedBy: string;
  timestamp: string;
}

// --- Claim Events ------------------------------------------------------------

export interface ClaimSubmittedEvent extends DomainEvent {
  claimId: string;
  trackingNumber: string;
  payerId: string;
  totalCharge: number; // cents
  clearinghouse: string;
  timestamp: string;
}

export interface ClaimDeniedEvent extends DomainEvent {
  claimId: string;
  denialReasonCode: string;
  remarkCodes: string[];
  originalChargeAmount: number;
  payerId: string;
}

export interface ClaimPaidEvent extends DomainEvent {
  claimId: string;
  paidAmount: number;
  patientResponsibility: number;
  checkNumber?: string;
  paymentDate: string;
}

// --- Appointment Events ------------------------------------------------------

export interface AppointmentScheduledEvent extends DomainEvent {
  appointmentId: string;
  patientId: string;
  providerId: string;
  appointmentType: string;
  dateTime: string;
  duration: number; // minutes
}

export interface AppointmentCancelledEvent extends DomainEvent {
  appointmentId: string;
  patientId: string;
  cancelledBy: string;
  reason?: string;
  timestamp: string;
}

export interface AppointmentCompletedEvent extends DomainEvent {
  appointmentId: string;
  patientId: string;
  providerId: string;
  encounterId: string;
  timestamp: string;
}

// --- Referral Events ---------------------------------------------------------

export interface ReferralCreatedEvent extends DomainEvent {
  referralId: string;
  patientId: string;
  referringProviderId: string;
  referredToProviderId?: string;
  urgency: string;
  timestamp: string;
}

export interface ReferralCompletedEvent extends DomainEvent {
  referralId: string;
  patientId: string;
  completionReason: string;
  visitsCompleted: number;
}

// --- Discharge Events --------------------------------------------------------

export interface PatientDischargedEvent extends DomainEvent {
  patientId: string;
  encounterId: string;
  dischargeDate: string;
  dischargeDisposition: string;
  pcpNotified: boolean;
  followUpCount: number;
  timestamp: string;
}

// --- Provider Events ---------------------------------------------------------

export interface ProviderCredentialingApprovedEvent extends DomainEvent {
  providerId: string;
  npi: string;
  effectiveDate: string;
  expirationDate: string;
}

export interface ProviderCredentialingDeniedEvent extends DomainEvent {
  providerId: string;
  npi: string;
  reason: string;
}

// --- System Events -----------------------------------------------------------

export interface InterventionOrderedEvent extends DomainEvent {
  patientId: string;
  encounterId: string;
  interventionType: string;
  assignedTo: string;
  priority: string;
  description: string;
}

export interface PatientStatementNeededEvent extends DomainEvent {
  patientId: string;
  balance: number;
  claimId: string;
}
