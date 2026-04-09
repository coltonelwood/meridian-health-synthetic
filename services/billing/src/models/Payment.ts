/**
 * Payment model
 *
 * Represents a payment made against one or more invoices.
 * Payments can come from patients (via Stripe) or insurance (via ERA/835).
 *
 * NOTE: We originally designed this assuming 1 payment = 1 invoice,
 * but then we needed to support applying a single payment across
 * multiple invoices (e.g., patient pays $500 and wants it split across
 * 3 invoices). The payment_allocations table handles this but the
 * code still has some assumptions about 1:1 relationships in places.
 * Watch out for that. - Derek, 2024-10
 */

export enum PaymentMethod {
  CREDIT_CARD = 'credit_card',
  DEBIT_CARD = 'debit_card',
  ACH = 'ach',
  CHECK = 'check',
  CASH = 'cash',
  WIRE = 'wire',
  INSURANCE_ERA = 'insurance_era', // Electronic Remittance Advice
  PATIENT_PORTAL = 'patient_portal', // online via patient portal
  POS = 'pos', // point of service (front desk)
  // we shouldn't have this but some old records have it
  OTHER = 'other',
  UNKNOWN = 'unknown',
}

export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
  VOIDED = 'voided',
  DISPUTED = 'disputed',
  // Stripe-specific statuses that leak into our model (oops)
  REQUIRES_ACTION = 'requires_action',
  REQUIRES_PAYMENT_METHOD = 'requires_payment_method',
}

export interface PaymentAllocation {
  id: string;
  payment_id: string;
  invoice_id: string;
  amount_cents: number;
  applied_at: Date;
}

export interface Payment {
  id: string;
  // Sequential payment reference number (PAY-2024-005678)
  payment_reference: string;

  // Patient who made the payment
  patient_id: string;
  patient_name?: string; // denormalized

  // Primary invoice (legacy - use allocations instead)
  invoice_id?: string;

  // Payment allocations (which invoices this payment applies to)
  allocations: PaymentAllocation[];

  // Amount
  amount_cents: number;
  currency: string; // ISO 4217, always 'usd' for us but the field exists

  // Method and status
  method: PaymentMethod;
  status: PaymentStatus;

  // Stripe integration
  stripe_payment_intent_id?: string;
  stripe_charge_id?: string;
  stripe_customer_id?: string;
  stripe_receipt_url?: string;

  // Card details (we store minimal info - Stripe has the rest)
  card_last_four?: string;
  card_brand?: string; // visa, mastercard, amex, etc.
  card_exp_month?: number;
  card_exp_year?: number;

  // Check details
  check_number?: string;
  check_date?: string;

  // Insurance payment details
  era_trace_number?: string;
  payer_claim_number?: string;

  // Refund info
  refund_amount_cents?: number;
  refund_reason?: string;
  refund_date?: Date;
  stripe_refund_id?: string;

  // Processing info
  processed_at?: Date;
  processing_fee_cents?: number; // Stripe processing fee

  // Receipt
  receipt_sent: boolean;
  receipt_sent_at?: Date;
  receipt_email?: string;

  // Notes
  internal_notes?: string;
  memo?: string; // patient-visible memo

  // Metadata
  created_at: Date;
  updated_at: Date;
  created_by?: string; // user who entered the payment (for manual payments)
  voided_at?: Date;
  voided_by?: string;
}

export type CreatePaymentInput = Omit<Payment,
  'id' | 'payment_reference' | 'created_at' | 'updated_at' |
  'allocations' | 'receipt_sent'
> & {
  // Override allocations to be simpler for creation
  allocations?: Array<{
    invoice_id: string;
    amount_cents: number;
  }>;
};
