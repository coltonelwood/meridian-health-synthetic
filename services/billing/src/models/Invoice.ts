/**
 * Invoice model
 *
 * Invoices in healthcare billing are complicated. An invoice can represent:
 * - Patient responsibility after insurance adjudication
 * - Self-pay charges for uninsured patients
 * - Copay/coinsurance/deductible amounts
 * - Charges that insurance denied
 *
 * The line items can reference CPT codes, HCPCS codes, or custom charge codes.
 * Each line item can have its own adjustments (contractual write-offs, discounts, etc.)
 *
 * We store amounts as integers (cents) in the database to avoid floating point
 * issues, but use Decimal.js in the service layer for calculations.
 */

export enum InvoiceStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  SENT = 'sent',
  PARTIALLY_PAID = 'partially_paid',
  PAID = 'paid',
  OVERDUE = 'overdue',
  COLLECTIONS = 'collections',
  VOIDED = 'voided',
  WRITE_OFF = 'write_off',
  // this was added for the payment plan feature but I'm not sure it's
  // semantically different from PARTIALLY_PAID. Keeping it for now.
  PAYMENT_PLAN = 'payment_plan',
}

export interface InvoiceLineItem {
  id: string;
  invoice_id: string;
  line_number: number;
  description: string;
  // CPT, HCPCS, or custom code
  charge_code?: string;
  charge_code_type?: 'CPT' | 'HCPCS' | 'CUSTOM' | 'REVENUE';
  // Service date(s) - can be a range for things like hospital stays
  service_date: string;
  service_date_end?: string;
  // Quantities and amounts (stored as cents)
  quantity: number;
  unit_price_cents: number;
  // gross charge
  total_cents: number;
  // Insurance adjustments/write-offs (this reduces what patient owes)
  adjustment_cents: number;
  adjustment_reason?: string;
  // What insurance paid
  insurance_paid_cents: number;
  // Net patient responsibility = total - adjustment - insurance_paid
  patient_responsibility_cents: number;
  // Tax (for non-medical services like cosmetic procedures)
  tax_cents: number;
  // Modifier codes (e.g., -25 for significant E/M)
  modifiers?: string[];
  // Diagnosis pointers (reference to which diagnosis codes apply to this line)
  diagnosis_pointers?: number[];
  // Rendering provider NPI
  rendering_provider_npi?: string;
}

export interface InvoiceAdjustment {
  id: string;
  invoice_id: string;
  type: 'discount' | 'write_off' | 'contractual' | 'charity' | 'admin' | 'prompt_pay';
  amount_cents: number;
  reason: string;
  applied_by?: string;
  applied_at: Date;
}

export interface Invoice {
  id: string;
  // Sequential invoice number for display (INV-2024-001234)
  invoice_number: string;

  // Patient/guarantor
  patient_id: string;
  guarantor_id?: string; // can be different from patient (e.g., parent for minor)
  patient_name?: string; // denormalized for display

  // Encounter/visit reference
  encounter_id?: string;
  claim_id?: string; // reference to the claim that generated this invoice

  // Provider info
  billing_provider_id: string;
  billing_provider_npi?: string;
  facility_id?: string;

  // Dates
  invoice_date: string;
  due_date: string;
  service_date: string;
  service_date_end?: string;

  // Status
  status: InvoiceStatus;
  status_changed_at?: Date;

  // Financial summary (all in cents)
  subtotal_cents: number;
  tax_cents: number;
  total_adjustments_cents: number;
  total_insurance_paid_cents: number;
  total_patient_responsibility_cents: number;
  total_payments_cents: number;
  balance_due_cents: number;

  // Line items and adjustments
  line_items: InvoiceLineItem[];
  adjustments: InvoiceAdjustment[];

  // Insurance info
  primary_insurance_id?: string;
  primary_insurance_name?: string;
  secondary_insurance_id?: string;

  // Payment terms
  payment_terms_days: number; // typically 30
  // For payment plans
  payment_plan_id?: string;
  payment_plan_installments?: number;

  // Statement/billing cycles
  statement_count: number; // how many times this has been billed
  last_statement_date?: string;

  // Collections
  sent_to_collections: boolean;
  collection_agency_id?: string;
  collection_date?: string;

  // Notes
  internal_notes?: string;
  patient_notes?: string; // visible on statement

  // Metadata
  created_at: Date;
  updated_at: Date;
  created_by?: string;
  voided_at?: Date;
  voided_by?: string;
  void_reason?: string;
}

export type CreateInvoiceInput = Omit<Invoice,
  'id' | 'invoice_number' | 'created_at' | 'updated_at' |
  'balance_due_cents' | 'total_payments_cents' | 'status_changed_at' |
  'statement_count'
>;
