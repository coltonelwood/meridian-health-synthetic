/**
 * ClaimLine model - individual service line items on a claim.
 *
 * Each claim has 1-N lines, each representing a procedure/service billed.
 * The line_number is 1-indexed and sequential within a claim.
 *
 * Modifiers are optional 2-character codes that provide additional info
 * about the service (e.g., "25" = significant, separately identifiable E&M).
 * We support up to 4 modifiers per line per the X12 spec but most claims
 * only use 1-2.
 */

export interface ClaimLine {
  id: string;
  claimId: string;
  lineNumber: number;

  // Procedure identification
  cptCode: string;           // 5-character CPT/HCPCS code
  modifier1?: string;        // 2-char modifier
  modifier2?: string;
  modifier3?: string;
  modifier4?: string;
  revenueCode?: string;      // 4-digit revenue code (institutional claims)
  ndcCode?: string;          // 11-digit National Drug Code

  // Diagnosis pointer - indexes into the claim's diagnosisCodes array (1-based)
  diagnosisPointer: number[];

  // Service details
  placeOfService?: string;   // 2-digit POS code
  serviceDateFrom?: string;  // can override claim-level dates
  serviceDateTo?: string;
  units: number;             // quantity of services
  unitType?: string;         // UN=unit, MJ=minutes, etc.

  // Financials
  chargeAmount: number;
  allowedAmount?: number;     // set during adjudication
  paidAmount?: number;        // set after payment
  adjustmentAmount?: number;  // contractual adjustments
  copayAmount?: number;
  coinsuranceAmount?: number;
  deductibleAmount?: number;

  // Adjudication result
  adjudicationStatus?: string;
  remarkCodes?: string[];          // RARC codes
  adjustmentReasonCodes?: string[]; // CARC codes

  // Rendering provider override
  renderingProviderNpi?: string;

  createdAt: Date;
  updatedAt: Date;
}

export interface CreateClaimLineInput {
  cptCode: string;
  modifier1?: string;
  modifier2?: string;
  modifier3?: string;
  modifier4?: string;
  revenueCode?: string;
  ndcCode?: string;
  diagnosisPointer?: number[];
  placeOfService?: string;
  serviceDateFrom?: string;
  serviceDateTo?: string;
  units?: number;
  unitType?: string;
  chargeAmount: number;
  renderingProviderNpi?: string;
}

export interface ClaimLineRow {
  id: string;
  claim_id: string;
  line_number: number;
  cpt_code: string;
  modifier_1: string | null;
  modifier_2: string | null;
  modifier_3: string | null;
  modifier_4: string | null;
  revenue_code: string | null;
  ndc_code: string | null;
  diagnosis_pointer: number[];
  place_of_service: string | null;
  service_date_from: string | null;
  service_date_to: string | null;
  units: string; // pg returns decimal as string
  unit_type: string | null;
  charge_amount: string;
  allowed_amount: string | null;
  paid_amount: string | null;
  adjustment_amount: string | null;
  copay_amount: string | null;
  coinsurance_amount: string | null;
  deductible_amount: string | null;
  adjudication_status: string | null;
  remark_codes: string[] | null;
  adjustment_reason_codes: string[] | null;
  rendering_provider_npi: string | null;
  created_at: string;
  updated_at: string;
}

export function claimLineFromRow(row: ClaimLineRow): ClaimLine {
  return {
    id: row.id,
    claimId: row.claim_id,
    lineNumber: row.line_number,
    cptCode: row.cpt_code,
    modifier1: row.modifier_1 || undefined,
    modifier2: row.modifier_2 || undefined,
    modifier3: row.modifier_3 || undefined,
    modifier4: row.modifier_4 || undefined,
    revenueCode: row.revenue_code || undefined,
    ndcCode: row.ndc_code || undefined,
    diagnosisPointer: row.diagnosis_pointer || [1],
    placeOfService: row.place_of_service || undefined,
    serviceDateFrom: row.service_date_from || undefined,
    serviceDateTo: row.service_date_to || undefined,
    units: parseFloat(row.units) || 1,
    unitType: row.unit_type || undefined,
    chargeAmount: parseFloat(row.charge_amount) || 0,
    allowedAmount: row.allowed_amount ? parseFloat(row.allowed_amount) : undefined,
    paidAmount: row.paid_amount ? parseFloat(row.paid_amount) : undefined,
    adjustmentAmount: row.adjustment_amount ? parseFloat(row.adjustment_amount) : undefined,
    copayAmount: row.copay_amount ? parseFloat(row.copay_amount) : undefined,
    coinsuranceAmount: row.coinsurance_amount ? parseFloat(row.coinsurance_amount) : undefined,
    deductibleAmount: row.deductible_amount ? parseFloat(row.deductible_amount) : undefined,
    adjudicationStatus: row.adjudication_status || undefined,
    remarkCodes: row.remark_codes || undefined,
    adjustmentReasonCodes: row.adjustment_reason_codes || undefined,
    renderingProviderNpi: row.rendering_provider_npi || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get modifiers as an array (filtering out nulls).
 * Used when building X12 segments.
 */
export function getModifiers(line: ClaimLine): string[] {
  return [line.modifier1, line.modifier2, line.modifier3, line.modifier4]
    .filter((m): m is string => m !== undefined && m !== null && m.trim() !== '');
}

/**
 * Calculate the total patient responsibility for a line item.
 * This is copay + coinsurance + deductible.
 * Returns 0 if no patient responsibility amounts are set.
 */
export function getLinePatientResponsibility(line: ClaimLine): number {
  return (line.copayAmount || 0) + (line.coinsuranceAmount || 0) + (line.deductibleAmount || 0);
}
