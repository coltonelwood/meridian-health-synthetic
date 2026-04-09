-- Migration: 001_create_invoices
-- Created: 2024-01-20
-- Author: derek.johnson@meridianhealth.io

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Invoice number sequence
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 100001;

CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_number VARCHAR(20) NOT NULL UNIQUE,

    -- Patient/guarantor
    patient_id UUID NOT NULL,
    guarantor_id UUID,
    patient_name VARCHAR(200), -- denormalized, I know, but it's on every invoice

    -- References
    encounter_id UUID,
    claim_id UUID,

    -- Provider
    billing_provider_id UUID NOT NULL,
    billing_provider_npi VARCHAR(10),
    facility_id UUID,

    -- Dates
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    service_date DATE,
    service_date_end DATE,

    -- Status
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    status_changed_at TIMESTAMP WITH TIME ZONE,

    -- Financial totals (all in cents to avoid float issues)
    subtotal_cents BIGINT NOT NULL DEFAULT 0,
    tax_cents BIGINT NOT NULL DEFAULT 0,
    total_adjustments_cents BIGINT NOT NULL DEFAULT 0,
    total_insurance_paid_cents BIGINT NOT NULL DEFAULT 0,
    total_patient_responsibility_cents BIGINT NOT NULL DEFAULT 0,
    total_payments_cents BIGINT NOT NULL DEFAULT 0,
    balance_due_cents BIGINT NOT NULL DEFAULT 0,

    -- Insurance
    primary_insurance_id UUID,
    primary_insurance_name VARCHAR(200),
    secondary_insurance_id UUID,

    -- Payment terms
    payment_terms_days INTEGER DEFAULT 30,
    payment_plan_id UUID,
    payment_plan_installments INTEGER,

    -- Statements
    statement_count INTEGER DEFAULT 0,
    last_statement_date DATE,

    -- Collections
    sent_to_collections BOOLEAN DEFAULT false,
    collection_agency_id UUID,
    collection_date DATE,

    -- Notes
    internal_notes TEXT,
    patient_notes TEXT,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(100),
    voided_at TIMESTAMP WITH TIME ZONE,
    voided_by VARCHAR(100),
    void_reason TEXT
);

CREATE INDEX idx_invoices_patient ON invoices (patient_id);
CREATE INDEX idx_invoices_status ON invoices (status) WHERE voided_at IS NULL;
CREATE INDEX idx_invoices_due_date ON invoices (due_date) WHERE balance_due_cents > 0 AND voided_at IS NULL;
CREATE INDEX idx_invoices_encounter ON invoices (encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX idx_invoices_claim ON invoices (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX idx_invoices_date ON invoices (invoice_date);
-- For the aging report
CREATE INDEX idx_invoices_aging ON invoices (due_date, balance_due_cents) WHERE voided_at IS NULL AND status NOT IN ('paid', 'voided', 'write_off');

CREATE TABLE IF NOT EXISTS invoice_line_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    description TEXT NOT NULL,
    charge_code VARCHAR(20),
    charge_code_type VARCHAR(10), -- CPT, HCPCS, CUSTOM, REVENUE
    service_date DATE,
    service_date_end DATE,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price_cents BIGINT NOT NULL,
    total_cents BIGINT NOT NULL,
    adjustment_cents BIGINT DEFAULT 0,
    adjustment_reason TEXT,
    insurance_paid_cents BIGINT DEFAULT 0,
    patient_responsibility_cents BIGINT NOT NULL,
    tax_cents BIGINT DEFAULT 0,
    modifiers TEXT[] DEFAULT '{}',
    diagnosis_pointers INTEGER[] DEFAULT '{}',
    rendering_provider_npi VARCHAR(10)
);

CREATE INDEX idx_line_items_invoice ON invoice_line_items (invoice_id);
CREATE INDEX idx_line_items_charge_code ON invoice_line_items (charge_code) WHERE charge_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_adjustments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL, -- discount, write_off, contractual, charity, admin, prompt_pay
    amount_cents BIGINT NOT NULL,
    reason TEXT,
    applied_by VARCHAR(100),
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_adjustments_invoice ON invoice_adjustments (invoice_id);
