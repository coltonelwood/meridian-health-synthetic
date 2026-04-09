-- Migration: 002_add_remittance
-- Author: dbadmin (Priya Ramanathan)
-- Date: 2023-09-22
-- Description: Remittance advice (ERA/835) tables.
--   These store parsed 835 data that comes back from payers/clearinghouses.
--   We match them to claims by claim_number + payer_id.
--
-- IMPORTANT: The matching logic is in remittanceProcessor.worker.ts and it's
-- not great. About 3-5% of remittances fail to auto-match and go into a
-- manual review queue. See CLAIMS-672 for the backlog of improvements.

BEGIN;

CREATE TYPE remittance_status AS ENUM (
    'RECEIVED',
    'PARSING',
    'PARSED',
    'MATCHING',
    'MATCHED',
    'PARTIALLY_MATCHED',
    'UNMATCHED',
    'APPLIED',
    'ERROR'
);

CREATE TABLE IF NOT EXISTS remittance_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_number VARCHAR(50) UNIQUE NOT NULL,
    status remittance_status NOT NULL DEFAULT 'RECEIVED',

    -- Source
    payer_id VARCHAR(50) NOT NULL,
    payer_name VARCHAR(255),
    clearinghouse_id VARCHAR(50),

    -- Payment info
    payment_method VARCHAR(20),  -- CHK, ACH, FWT, etc.
    payment_date DATE,
    payment_amount DECIMAL(14, 2),
    check_number VARCHAR(50),
    trace_number VARCHAR(50),

    -- Payee (us)
    payee_npi VARCHAR(10),
    payee_tax_id VARCHAR(15),
    payee_name VARCHAR(255),

    -- Raw EDI
    raw_x12_content TEXT,  -- the full 835 transaction
    -- ^ Yes we store the raw EDI. It's ugly but we need it for dispute
    -- resolution and audit purposes. Some of these are 500KB+.
    -- We talked about moving to S3 but haven't gotten to it. (CLAIMS-891)

    file_name VARCHAR(500),
    file_received_at TIMESTAMP WITH TIME ZONE,

    -- Processing
    total_claims_in_batch INTEGER DEFAULT 0,
    matched_claims INTEGER DEFAULT 0,
    unmatched_claims INTEGER DEFAULT 0,
    processing_errors JSONB DEFAULT '[]'::jsonb,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS remittance_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES remittance_batches(id) ON DELETE CASCADE,
    claim_id UUID REFERENCES claims(id),  -- nullable until matched

    -- Claim identification from the 835
    patient_control_number VARCHAR(50),  -- this should match our claim_number
    payer_claim_number VARCHAR(50),      -- the payer's internal claim ID
    claim_status_code VARCHAR(5),        -- 1=processed primary, 2=processed secondary, etc.

    -- Patient
    patient_first_name VARCHAR(100),
    patient_last_name VARCHAR(100),
    patient_id VARCHAR(80),
    subscriber_id VARCHAR(80),

    -- Financials
    charge_amount DECIMAL(12, 2),
    paid_amount DECIMAL(12, 2),
    patient_responsibility_amount DECIMAL(12, 2),

    -- Adjustments at claim level
    -- group_code: CO (contractual), PR (patient resp), OA (other), PI (payer initiated)
    adjustments JSONB DEFAULT '[]'::jsonb,
    /*
      Format: [
        {
          "group_code": "CO",
          "reason_code": "45",
          "amount": 150.00,
          "quantity": 0
        },
        ...
      ]
    */

    -- Service line details
    service_lines JSONB DEFAULT '[]'::jsonb,
    /*
      Format: [
        {
          "procedure_code": "99213",
          "modifiers": ["25"],
          "charge_amount": 250.00,
          "paid_amount": 175.00,
          "units": 1,
          "adjustments": [...],
          "remark_codes": ["N362"]
        }
      ]
    */

    -- Matching
    match_status VARCHAR(20) DEFAULT 'PENDING',
    match_confidence DECIMAL(5, 2),  -- 0.00 to 100.00
    match_method VARCHAR(50),  -- AUTO, MANUAL, FUZZY
    matched_at TIMESTAMP WITH TIME ZONE,
    matched_by VARCHAR(100),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- For denial/appeal tracking we need to store CARC and RARC codes
-- CARC = Claim Adjustment Reason Code
-- RARC = Remittance Advice Remark Code
-- These come from X12 and Washington Publishing Company (WPC)
CREATE TABLE IF NOT EXISTS adjustment_reason_codes (
    code VARCHAR(10) PRIMARY KEY,
    code_type VARCHAR(4) NOT NULL,  -- CARC or RARC
    description TEXT NOT NULL,
    -- Some of these codes trigger automatic appeal workflows
    auto_appeal_eligible BOOLEAN DEFAULT FALSE,
    notes TEXT,
    effective_date DATE,
    termination_date DATE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Seed some common CARC codes that we see all the time
-- Full list should be loaded from WPC data file (see scripts/seed-carc-rarc.ts)
INSERT INTO adjustment_reason_codes (code, code_type, description, auto_appeal_eligible) VALUES
    ('1', 'CARC', 'Deductible Amount', FALSE),
    ('2', 'CARC', 'Coinsurance Amount', FALSE),
    ('3', 'CARC', 'Co-payment Amount', FALSE),
    ('4', 'CARC', 'The procedure code is inconsistent with the modifier used or a required modifier is missing.', TRUE),
    ('5', 'CARC', 'The procedure code/bill type is inconsistent with the place of service.', TRUE),
    ('16', 'CARC', 'Claim/service lacks information or has submission/billing error(s).', TRUE),
    ('18', 'CARC', 'Exact duplicate claim/service.', FALSE),
    ('22', 'CARC', 'This care may be covered by another payer per coordination of benefits.', FALSE),
    ('23', 'CARC', 'The impact of prior payer(s) adjudication including payments and/or adjustments.', FALSE),
    ('27', 'CARC', 'Expenses incurred after coverage terminated.', FALSE),
    ('29', 'CARC', 'The time limit for filing has expired.', FALSE),
    ('45', 'CARC', 'Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.', FALSE),
    ('50', 'CARC', 'These are non-covered services because this is not deemed a medical necessity by the payer.', TRUE),
    ('96', 'CARC', 'Non-covered charge(s).', TRUE),
    ('97', 'CARC', 'The benefit for this service is included in the payment/allowance for another service/procedure that has already been adjudicated.', FALSE),
    ('109', 'CARC', 'Claim/service not covered by this payer/contractor.', TRUE),
    ('197', 'CARC', 'Precertification/authorization/notification/pre-treatment absent.', TRUE),
    ('204', 'CARC', 'This service/equipment/drug is not covered under the patient''s current benefit plan.', FALSE),
    ('242', 'CARC', 'Services not provided by network/primary care providers.', FALSE),
    ('N362', 'RARC', 'The above allowance is calculated based on the appropriate fee schedule.', FALSE),
    ('N432', 'RARC', 'Alert: Adjustment based on a Recovery Audit.', FALSE),
    ('MA130', 'RARC', 'Your claim contains incomplete and/or invalid information.', TRUE)
ON CONFLICT (code) DO NOTHING;

-- Indexes
CREATE INDEX idx_remittance_batches_status ON remittance_batches(status);
CREATE INDEX idx_remittance_batches_payer ON remittance_batches(payer_id);
CREATE INDEX idx_remittance_batches_payment_date ON remittance_batches(payment_date);
CREATE INDEX idx_remittance_details_batch ON remittance_details(batch_id);
CREATE INDEX idx_remittance_details_claim ON remittance_details(claim_id);
CREATE INDEX idx_remittance_details_match_status ON remittance_details(match_status);
CREATE INDEX idx_remittance_details_pcn ON remittance_details(patient_control_number);

CREATE TRIGGER update_remittance_batches_updated_at
    BEFORE UPDATE ON remittance_batches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_remittance_details_updated_at
    BEFORE UPDATE ON remittance_details
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;
