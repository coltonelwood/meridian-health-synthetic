-- Migration: 001_create_claims
-- Author: dbadmin (Priya Ramanathan)
-- Date: 2023-06-14
-- Description: Initial claims schema. Based on the X12 837P/837I data model
--   but flattened for our use case. We normalize line items into claim_lines.

BEGIN;

CREATE TYPE claim_status AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'PENDING_REVIEW',
    'ADJUDICATED',
    'DENIED',
    'APPEALED',
    'PAID',
    'VOID'
);

CREATE TYPE claim_type AS ENUM (
    'PROFESSIONAL',   -- 837P
    'INSTITUTIONAL',  -- 837I
    'DENTAL'          -- 837D - not fully supported yet
);

CREATE TYPE filing_indicator AS ENUM (
    'COMMERCIAL',
    'MEDICARE_A',
    'MEDICARE_B',
    'MEDICAID',
    'TRICARE',
    'CHAMPVA',
    'GROUP_HEALTH',
    'FECA',
    'OTHER'
);

CREATE TABLE IF NOT EXISTS claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_number VARCHAR(50) UNIQUE NOT NULL,
    status claim_status NOT NULL DEFAULT 'DRAFT',
    claim_type claim_type NOT NULL,
    filing_indicator filing_indicator NOT NULL DEFAULT 'COMMERCIAL',

    -- Subscriber / Patient
    subscriber_id VARCHAR(80) NOT NULL,
    patient_id VARCHAR(80) NOT NULL,
    patient_first_name VARCHAR(100),
    patient_last_name VARCHAR(100),
    patient_dob DATE,
    patient_gender CHAR(1),
    patient_address_line1 VARCHAR(255),
    patient_address_line2 VARCHAR(255),
    patient_city VARCHAR(100),
    patient_state CHAR(2),
    patient_zip VARCHAR(10),
    relationship_to_subscriber VARCHAR(2) DEFAULT '18',  -- 18 = self

    -- Provider
    billing_provider_npi VARCHAR(10) NOT NULL,
    billing_provider_tax_id VARCHAR(15),
    billing_provider_name VARCHAR(255),
    rendering_provider_npi VARCHAR(10),
    referring_provider_npi VARCHAR(10),
    facility_npi VARCHAR(10),
    place_of_service VARCHAR(2) DEFAULT '11',  -- 11 = office

    -- Payer
    payer_id VARCHAR(50) NOT NULL,
    payer_name VARCHAR(255),
    plan_id VARCHAR(80),
    group_number VARCHAR(50),
    prior_auth_number VARCHAR(50),

    -- Diagnosis (ICD-10)
    -- NOTE: we store up to 12 dx codes as an array. The X12 spec supports
    -- more but we've never seen a claim with more than 12 in production.
    -- If this changes, we'll need to normalize into a separate table.
    diagnosis_codes VARCHAR(10)[] NOT NULL DEFAULT '{}',
    diagnosis_code_type VARCHAR(5) DEFAULT 'ABK',  -- ABK = ICD-10-CM

    -- Financials
    total_charge_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_paid_amount DECIMAL(12, 2) DEFAULT 0.00,
    patient_responsibility DECIMAL(12, 2) DEFAULT 0.00,
    -- ^ this gets computed during adjudication but we cache it here

    -- Dates
    service_date_from DATE,
    service_date_to DATE,
    admission_date DATE,
    discharge_date DATE,
    received_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    adjudicated_date TIMESTAMP WITH TIME ZONE,
    paid_date TIMESTAMP WITH TIME ZONE,

    -- Coordination of Benefits
    -- TODO: properly support COB / secondary payer scenarios
    -- Right now we just store if there IS another payer but don't
    -- actually process secondary claims (CLAIMS-445)
    is_secondary_claim BOOLEAN DEFAULT FALSE,
    primary_payer_id VARCHAR(50),
    primary_claim_number VARCHAR(50),

    -- Denial tracking
    denial_reason_code VARCHAR(10),
    denial_reason_description TEXT,
    denial_date TIMESTAMP WITH TIME ZONE,
    appeal_deadline DATE,

    -- EDI tracking
    original_x12_transaction_id VARCHAR(100),
    submission_batch_id VARCHAR(100),
    clearinghouse_trace_number VARCHAR(100),

    -- Metadata
    created_by VARCHAR(100),
    updated_by VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,  -- soft delete
    version INTEGER NOT NULL DEFAULT 1,   -- optimistic locking
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS claim_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,

    -- Procedure
    cpt_code VARCHAR(5) NOT NULL,
    modifier_1 VARCHAR(2),
    modifier_2 VARCHAR(2),
    modifier_3 VARCHAR(2),
    modifier_4 VARCHAR(2),
    -- Some old code still references "hcpcs_code" - it's the same as cpt_code
    -- for professional claims. Don't add a separate column. - DR 2024-01
    revenue_code VARCHAR(4),  -- institutional claims only
    ndc_code VARCHAR(11),      -- drug claims

    -- Diagnosis pointer (references position in claims.diagnosis_codes array)
    diagnosis_pointer INTEGER[] NOT NULL DEFAULT '{1}',

    -- Service details
    place_of_service VARCHAR(2) DEFAULT '11',
    service_date_from DATE,
    service_date_to DATE,
    units DECIMAL(7, 2) NOT NULL DEFAULT 1.00,
    unit_type VARCHAR(2) DEFAULT 'UN',  -- UN = unit

    -- Financials
    charge_amount DECIMAL(12, 2) NOT NULL,
    allowed_amount DECIMAL(12, 2),
    paid_amount DECIMAL(12, 2),
    adjustment_amount DECIMAL(12, 2),
    copay_amount DECIMAL(12, 2),
    coinsurance_amount DECIMAL(12, 2),
    deductible_amount DECIMAL(12, 2),

    -- Adjudication
    adjudication_status VARCHAR(20),
    remark_codes VARCHAR(10)[] DEFAULT '{}',
    adjustment_reason_codes VARCHAR(10)[] DEFAULT '{}',

    -- Rendering provider override (if different from claim-level)
    rendering_provider_npi VARCHAR(10),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE(claim_id, line_number)
);

-- Status changes are important for audit / compliance (HIPAA, SOC2)
CREATE TABLE IF NOT EXISTS claim_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    from_status claim_status,
    to_status claim_status NOT NULL,
    changed_by VARCHAR(100),
    change_reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_payer_id ON claims(payer_id);
CREATE INDEX idx_claims_subscriber_id ON claims(subscriber_id);
CREATE INDEX idx_claims_patient_id ON claims(patient_id);
CREATE INDEX idx_claims_billing_provider ON claims(billing_provider_npi);
CREATE INDEX idx_claims_claim_number ON claims(claim_number);
CREATE INDEX idx_claims_received_date ON claims(received_date);
CREATE INDEX idx_claims_service_date ON claims(service_date_from, service_date_to);
CREATE INDEX idx_claims_created_at ON claims(created_at);
-- partial index for active claims only (most queries filter out VOID/PAID)
CREATE INDEX idx_claims_active ON claims(status) WHERE status NOT IN ('VOID', 'PAID');
CREATE INDEX idx_claims_deleted_at ON claims(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX idx_claim_lines_claim_id ON claim_lines(claim_id);
CREATE INDEX idx_claim_lines_cpt ON claim_lines(cpt_code);
CREATE INDEX idx_claim_status_history_claim_id ON claim_status_history(claim_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_claims_updated_at
    BEFORE UPDATE ON claims
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_claim_lines_updated_at
    BEFORE UPDATE ON claim_lines
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;
