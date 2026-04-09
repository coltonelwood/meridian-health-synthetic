-- Migration: 002_create_payments
-- Created: 2024-01-25
-- Author: derek.johnson@meridianhealth.io
-- Depends on: 001_create_invoices

-- Payment number sequence
CREATE SEQUENCE IF NOT EXISTS payment_number_seq START WITH 200001;

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_reference VARCHAR(20) NOT NULL UNIQUE,

    -- Patient
    patient_id UUID NOT NULL,
    patient_name VARCHAR(200),

    -- Legacy single-invoice reference (use allocations instead)
    -- We keep this column for backwards compatibility but new payments
    -- should use the payment_allocations table
    invoice_id UUID,

    -- Amount
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    currency VARCHAR(3) DEFAULT 'usd',

    -- Method and status
    method VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',

    -- Stripe
    stripe_payment_intent_id VARCHAR(100),
    stripe_charge_id VARCHAR(100),
    stripe_customer_id VARCHAR(100),
    stripe_receipt_url TEXT,

    -- Card details (minimal - PCI compliance)
    card_last_four CHAR(4),
    card_brand VARCHAR(20),
    card_exp_month SMALLINT,
    card_exp_year SMALLINT,

    -- Check details
    check_number VARCHAR(20),
    check_date DATE,

    -- Insurance payment
    era_trace_number VARCHAR(50),
    payer_claim_number VARCHAR(50),

    -- Refund
    refund_amount_cents BIGINT,
    refund_reason TEXT,
    refund_date TIMESTAMP WITH TIME ZONE,
    stripe_refund_id VARCHAR(100),

    -- Processing
    processed_at TIMESTAMP WITH TIME ZONE,
    processing_fee_cents BIGINT,

    -- Receipt
    receipt_sent BOOLEAN DEFAULT false,
    receipt_sent_at TIMESTAMP WITH TIME ZONE,
    receipt_email VARCHAR(255),

    -- Notes
    internal_notes TEXT,
    memo VARCHAR(500),

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(100),
    voided_at TIMESTAMP WITH TIME ZONE,
    voided_by VARCHAR(100)
);

CREATE INDEX idx_payments_patient ON payments (patient_id);
CREATE INDEX idx_payments_status ON payments (status);
CREATE INDEX idx_payments_stripe_pi ON payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX idx_payments_stripe_charge ON payments (stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;
CREATE INDEX idx_payments_date ON payments (created_at);
CREATE INDEX idx_payments_method ON payments (method);

-- Payment allocations - maps payments to invoices (many-to-many)
-- Added in v2.8 when we needed to split payments across invoices
CREATE TABLE IF NOT EXISTS payment_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES invoices(id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_allocations_payment ON payment_allocations (payment_id);
CREATE INDEX idx_allocations_invoice ON payment_allocations (invoice_id);

-- Patient to Stripe customer mapping
-- Separated from the patient table because billing is a different service
-- and we don't want cross-database foreign keys
CREATE TABLE IF NOT EXISTS patient_stripe_mapping (
    patient_id UUID PRIMARY KEY,
    stripe_customer_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_stripe_mapping_customer ON patient_stripe_mapping (stripe_customer_id);
