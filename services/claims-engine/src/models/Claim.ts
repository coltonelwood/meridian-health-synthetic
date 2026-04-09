/**
 * Claim model - represents an insurance claim (837P/837I).
 *
 * This is one of the oldest models in the system and it shows. Some fields
 * are remnants from the old ClaimMD integration we ripped out in 2024-Q1.
 * Others were added piecemeal for specific payer requirements.
 *
 * If you're wondering why some fields are optional and others aren't,
 * the answer is "historical reasons" and "it depends on the claim type."
 */

export enum ClaimStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  PENDING_REVIEW = 'PENDING_REVIEW',
  ADJUDICATED = 'ADJUDICATED',
  DENIED = 'DENIED',
  APPEALED = 'APPEALED',
  PAID = 'PAID',
  VOID = 'VOID',
}

export enum ClaimType {
  PROFESSIONAL = 'PROFESSIONAL',
  INSTITUTIONAL = 'INSTITUTIONAL',
  DENTAL = 'DENTAL', // not fully supported - see CLAIMS-334
}

export enum FilingIndicator {
  COMMERCIAL = 'COMMERCIAL',
  MEDICARE_A = 'MEDICARE_A',
  MEDICARE_B = 'MEDICARE_B',
  MEDICAID = 'MEDICAID',
  TRICARE = 'TRICARE',
  CHAMPVA = 'CHAMPVA',
  GROUP_HEALTH = 'GROUP_HEALTH',
  FECA = 'FECA',
  OTHER = 'OTHER',
}

// Valid status transitions. This is enforced in the service layer but
// honestly we should also enforce it at the DB level with a trigger.
// Right now there's nothing stopping a direct SQL update from putting
// a claim into an invalid state. Ask me how I know. - Derek 2024-03
export const VALID_STATUS_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  [ClaimStatus.DRAFT]: [ClaimStatus.SUBMITTED, ClaimStatus.VOID],
  [ClaimStatus.SUBMITTED]: [ClaimStatus.PENDING_REVIEW, ClaimStatus.ADJUDICATED, ClaimStatus.DENIED, ClaimStatus.VOID],
  [ClaimStatus.PENDING_REVIEW]: [ClaimStatus.ADJUDICATED, ClaimStatus.DENIED, ClaimStatus.VOID],
  [ClaimStatus.ADJUDICATED]: [ClaimStatus.PAID, ClaimStatus.DENIED, ClaimStatus.VOID],
  [ClaimStatus.DENIED]: [ClaimStatus.APPEALED, ClaimStatus.VOID],
  [ClaimStatus.APPEALED]: [ClaimStatus.PENDING_REVIEW, ClaimStatus.ADJUDICATED, ClaimStatus.DENIED, ClaimStatus.PAID, ClaimStatus.VOID],
  [ClaimStatus.PAID]: [ClaimStatus.VOID],  // can only void after payment
  [ClaimStatus.VOID]: [],  // terminal state
};

export interface PatientInfo {
  patientId: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string; // ISO date string
  gender?: 'M' | 'F' | 'U';  // U = unknown. Some old records have 'X' but we normalize to 'U'
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  relationshipToSubscriber?: string; // X12 relationship code: 18=self, 01=spouse, 19=child, etc.
}

export interface ProviderInfo {
  billingProviderNpi: string;
  billingProviderTaxId?: string;
  billingProviderName?: string;
  renderingProviderNpi?: string;
  referringProviderNpi?: string;
  facilityNpi?: string;
  placeOfService?: string; // 2-digit CMS place of service code
}

export interface PayerInfo {
  payerId: string;
  payerName?: string;
  planId?: string;
  groupNumber?: string;
  priorAuthNumber?: string;
}

export interface CoordinationOfBenefits {
  isSecondaryClaim: boolean;
  primaryPayerId?: string;
  primaryClaimNumber?: string;
  // TODO: add primary payer payment info for proper COB adjudication
}

export interface DenialInfo {
  reasonCode?: string;        // CARC code
  reasonDescription?: string;
  denialDate?: Date;
  appealDeadline?: Date;     // usually 90-180 days from denial depending on payer
}

export interface Claim {
  id: string;
  claimNumber: string;
  status: ClaimStatus;
  claimType: ClaimType;
  filingIndicator: FilingIndicator;

  // Subscriber info - sometimes same as patient, sometimes not
  subscriberId: string;

  patient: PatientInfo;
  provider: ProviderInfo;
  payer: PayerInfo;

  // Diagnosis codes (ICD-10-CM)
  diagnosisCodes: string[];
  diagnosisCodeType: string;  // ABK = ICD-10-CM, ABF = ICD-10-PCS (institutional)

  // Financials
  totalChargeAmount: number;
  totalPaidAmount?: number;
  patientResponsibility?: number;

  // Dates
  serviceDateFrom?: string;
  serviceDateTo?: string;
  admissionDate?: string;     // institutional only
  dischargeDate?: string;     // institutional only
  receivedDate?: Date;
  adjudicatedDate?: Date;
  paidDate?: Date;

  // COB
  coordinationOfBenefits?: CoordinationOfBenefits;

  // Denial
  denial?: DenialInfo;

  // EDI tracking
  originalX12TransactionId?: string;
  submissionBatchId?: string;
  clearinghouseTraceNumber?: string;

  // Audit
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  version: number;

  // Grab bag for payer-specific fields that don't fit anywhere else.
  // This has gotten out of hand. We need a proper extension mechanism.
  metadata?: Record<string, any>;
}

// For creating new claims - most fields optional
export interface CreateClaimInput {
  claimType: ClaimType;
  filingIndicator?: FilingIndicator;
  subscriberId: string;
  patient: PatientInfo;
  provider: ProviderInfo;
  payer: PayerInfo;
  diagnosisCodes: string[];
  diagnosisCodeType?: string;
  serviceDateFrom: string;
  serviceDateTo?: string;
  admissionDate?: string;
  dischargeDate?: string;
  coordinationOfBenefits?: CoordinationOfBenefits;
  priorAuthNumber?: string;
  metadata?: Record<string, any>;
  createdBy?: string;
}

// Row from the database - snake_case
export interface ClaimRow {
  id: string;
  claim_number: string;
  status: string;
  claim_type: string;
  filing_indicator: string;
  subscriber_id: string;
  patient_id: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  patient_dob: string | null;
  patient_gender: string | null;
  patient_address_line1: string | null;
  patient_address_line2: string | null;
  patient_city: string | null;
  patient_state: string | null;
  patient_zip: string | null;
  relationship_to_subscriber: string | null;
  billing_provider_npi: string;
  billing_provider_tax_id: string | null;
  billing_provider_name: string | null;
  rendering_provider_npi: string | null;
  referring_provider_npi: string | null;
  facility_npi: string | null;
  place_of_service: string | null;
  payer_id: string;
  payer_name: string | null;
  plan_id: string | null;
  group_number: string | null;
  prior_auth_number: string | null;
  diagnosis_codes: string[];
  diagnosis_code_type: string;
  total_charge_amount: string;  // pg returns numeric as string
  total_paid_amount: string | null;
  patient_responsibility: string | null;
  service_date_from: string | null;
  service_date_to: string | null;
  admission_date: string | null;
  discharge_date: string | null;
  received_date: string;
  adjudicated_date: string | null;
  paid_date: string | null;
  is_secondary_claim: boolean;
  primary_payer_id: string | null;
  primary_claim_number: string | null;
  denial_reason_code: string | null;
  denial_reason_description: string | null;
  denial_date: string | null;
  appeal_deadline: string | null;
  original_x12_transaction_id: string | null;
  submission_batch_id: string | null;
  clearinghouse_trace_number: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  metadata: Record<string, any>;
}

/**
 * Converts a database row to a Claim domain object.
 * This is tedious but necessary because PG column naming !== our TS conventions.
 */
export function claimFromRow(row: ClaimRow): Claim {
  return {
    id: row.id,
    claimNumber: row.claim_number,
    status: row.status as ClaimStatus,
    claimType: row.claim_type as ClaimType,
    filingIndicator: row.filing_indicator as FilingIndicator,
    subscriberId: row.subscriber_id,
    patient: {
      patientId: row.patient_id,
      firstName: row.patient_first_name || undefined,
      lastName: row.patient_last_name || undefined,
      dateOfBirth: row.patient_dob || undefined,
      gender: (row.patient_gender as 'M' | 'F' | 'U') || undefined,
      addressLine1: row.patient_address_line1 || undefined,
      addressLine2: row.patient_address_line2 || undefined,
      city: row.patient_city || undefined,
      state: row.patient_state || undefined,
      zip: row.patient_zip || undefined,
      relationshipToSubscriber: row.relationship_to_subscriber || undefined,
    },
    provider: {
      billingProviderNpi: row.billing_provider_npi,
      billingProviderTaxId: row.billing_provider_tax_id || undefined,
      billingProviderName: row.billing_provider_name || undefined,
      renderingProviderNpi: row.rendering_provider_npi || undefined,
      referringProviderNpi: row.referring_provider_npi || undefined,
      facilityNpi: row.facility_npi || undefined,
      placeOfService: row.place_of_service || undefined,
    },
    payer: {
      payerId: row.payer_id,
      payerName: row.payer_name || undefined,
      planId: row.plan_id || undefined,
      groupNumber: row.group_number || undefined,
      priorAuthNumber: row.prior_auth_number || undefined,
    },
    diagnosisCodes: row.diagnosis_codes || [],
    diagnosisCodeType: row.diagnosis_code_type || 'ABK',
    totalChargeAmount: parseFloat(row.total_charge_amount) || 0,
    totalPaidAmount: row.total_paid_amount ? parseFloat(row.total_paid_amount) : undefined,
    patientResponsibility: row.patient_responsibility ? parseFloat(row.patient_responsibility) : undefined,
    serviceDateFrom: row.service_date_from || undefined,
    serviceDateTo: row.service_date_to || undefined,
    admissionDate: row.admission_date || undefined,
    dischargeDate: row.discharge_date || undefined,
    receivedDate: row.received_date ? new Date(row.received_date) : undefined,
    adjudicatedDate: row.adjudicated_date ? new Date(row.adjudicated_date) : undefined,
    paidDate: row.paid_date ? new Date(row.paid_date) : undefined,
    coordinationOfBenefits: {
      isSecondaryClaim: row.is_secondary_claim || false,
      primaryPayerId: row.primary_payer_id || undefined,
      primaryClaimNumber: row.primary_claim_number || undefined,
    },
    denial: row.denial_reason_code ? {
      reasonCode: row.denial_reason_code,
      reasonDescription: row.denial_reason_description || undefined,
      denialDate: row.denial_date ? new Date(row.denial_date) : undefined,
      appealDeadline: row.appeal_deadline ? new Date(row.appeal_deadline) : undefined,
    } : undefined,
    originalX12TransactionId: row.original_x12_transaction_id || undefined,
    submissionBatchId: row.submission_batch_id || undefined,
    clearinghouseTraceNumber: row.clearinghouse_trace_number || undefined,
    createdBy: row.created_by || undefined,
    updatedBy: row.updated_by || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
    version: row.version,
    metadata: row.metadata || {},
  };
}
