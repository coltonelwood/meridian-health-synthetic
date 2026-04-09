/**
 * Remittance / ERA (Electronic Remittance Advice) models.
 *
 * ERA data comes from 835 EDI transactions sent by payers after they
 * process our claims. We parse the 835, match each detail to our claims,
 * and apply the payment/adjustment info.
 *
 * The 835 is one of the more painful X12 transaction sets to deal with
 * because every payer formats theirs slightly differently. We've seen
 * everything from missing CLP segments to claims split across multiple
 * 835s to payers who put the wrong patient control number.
 */

export enum RemittanceStatus {
  RECEIVED = 'RECEIVED',
  PARSING = 'PARSING',
  PARSED = 'PARSED',
  MATCHING = 'MATCHING',
  MATCHED = 'MATCHED',
  PARTIALLY_MATCHED = 'PARTIALLY_MATCHED',
  UNMATCHED = 'UNMATCHED',
  APPLIED = 'APPLIED',
  ERROR = 'ERROR',
}

export interface RemittanceAdjustment {
  groupCode: 'CO' | 'PR' | 'OA' | 'PI' | 'CR';  // CR is deprecated but some payers still use it
  reasonCode: string;   // CARC code
  amount: number;
  quantity?: number;
}

export interface RemittanceServiceLine {
  procedureCode: string;
  modifiers?: string[];
  chargeAmount: number;
  paidAmount: number;
  units: number;
  adjustments: RemittanceAdjustment[];
  remarkCodes?: string[];  // RARC codes
  // Revenue code for institutional claims
  revenueCode?: string;
  // Dates of service
  serviceDateFrom?: string;
  serviceDateTo?: string;
}

export interface RemittanceBatch {
  id: string;
  batchNumber: string;
  status: RemittanceStatus;

  payerId: string;
  payerName?: string;
  clearinghouseId?: string;

  paymentMethod?: string;
  paymentDate?: string;
  paymentAmount?: number;
  checkNumber?: string;
  traceNumber?: string;

  payeeNpi?: string;
  payeeTaxId?: string;
  payeeName?: string;

  rawX12Content?: string;
  fileName?: string;
  fileReceivedAt?: Date;

  totalClaimsInBatch: number;
  matchedClaims: number;
  unmatchedClaims: number;
  processingErrors: any[];

  createdAt: Date;
  updatedAt: Date;
}

export interface RemittanceDetail {
  id: string;
  batchId: string;
  claimId?: string;  // null until matched

  // From the 835
  patientControlNumber?: string;
  payerClaimNumber?: string;
  claimStatusCode?: string;

  patientFirstName?: string;
  patientLastName?: string;
  patientId?: string;
  subscriberId?: string;

  chargeAmount?: number;
  paidAmount?: number;
  patientResponsibilityAmount?: number;

  adjustments: RemittanceAdjustment[];
  serviceLines: RemittanceServiceLine[];

  matchStatus: string;
  matchConfidence?: number;
  matchMethod?: string;
  matchedAt?: Date;
  matchedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

// Used when inserting parsed remittance data
export interface ParsedRemittance {
  payerId: string;
  payerName?: string;
  paymentMethod?: string;
  paymentDate?: string;
  paymentAmount?: number;
  checkNumber?: string;
  traceNumber?: string;
  payeeNpi?: string;
  payeeTaxId?: string;
  payeeName?: string;
  claims: ParsedRemittanceClaim[];
}

export interface ParsedRemittanceClaim {
  patientControlNumber: string;
  payerClaimNumber?: string;
  claimStatusCode?: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientId?: string;
  subscriberId?: string;
  chargeAmount: number;
  paidAmount: number;
  patientResponsibilityAmount?: number;
  adjustments: RemittanceAdjustment[];
  serviceLines: RemittanceServiceLine[];
}

// DB row mappings - abbreviated since the pattern is the same as Claim
export interface RemittanceBatchRow {
  id: string;
  batch_number: string;
  status: string;
  payer_id: string;
  payer_name: string | null;
  clearinghouse_id: string | null;
  payment_method: string | null;
  payment_date: string | null;
  payment_amount: string | null;
  check_number: string | null;
  trace_number: string | null;
  payee_npi: string | null;
  payee_tax_id: string | null;
  payee_name: string | null;
  raw_x12_content: string | null;
  file_name: string | null;
  file_received_at: string | null;
  total_claims_in_batch: number;
  matched_claims: number;
  unmatched_claims: number;
  processing_errors: any[];
  created_at: string;
  updated_at: string;
}

export function remittanceBatchFromRow(row: RemittanceBatchRow): RemittanceBatch {
  return {
    id: row.id,
    batchNumber: row.batch_number,
    status: row.status as RemittanceStatus,
    payerId: row.payer_id,
    payerName: row.payer_name || undefined,
    clearinghouseId: row.clearinghouse_id || undefined,
    paymentMethod: row.payment_method || undefined,
    paymentDate: row.payment_date || undefined,
    paymentAmount: row.payment_amount ? parseFloat(row.payment_amount) : undefined,
    checkNumber: row.check_number || undefined,
    traceNumber: row.trace_number || undefined,
    payeeNpi: row.payee_npi || undefined,
    payeeTaxId: row.payee_tax_id || undefined,
    payeeName: row.payee_name || undefined,
    rawX12Content: row.raw_x12_content || undefined,
    fileName: row.file_name || undefined,
    fileReceivedAt: row.file_received_at ? new Date(row.file_received_at) : undefined,
    totalClaimsInBatch: row.total_claims_in_batch,
    matchedClaims: row.matched_claims,
    unmatchedClaims: row.unmatched_claims,
    processingErrors: row.processing_errors || [],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
