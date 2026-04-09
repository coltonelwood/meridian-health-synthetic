-- Migration: 002_add_insurance
-- Created: 2023-08-22
-- Author: Platform Team (Rachel K.)
-- Description: Add insurance coverage table
-- Ticket: PLAT-1850
--
-- This adds the insurance_coverages table for tracking patient
-- insurance information. Supports primary/secondary/tertiary coverage.
--
-- Known limitation: we don't properly model coordination of benefits (COB)
-- or subscriber relationships. Those will need a future migration.

BEGIN;

CREATE TABLE insurance_coverages (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id          UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

    -- Payer info
    payer_name          VARCHAR(255) NOT NULL,
    payer_id            VARCHAR(50) NOT NULL, -- NAIC or payer-specific ID for EDI
    plan_type           VARCHAR(20) NOT NULL, -- HMO, PPO, EPO, etc.
    plan_name           VARCHAR(255),

    -- Member info
    member_id           VARCHAR(50) NOT NULL,
    group_number        VARCHAR(50),
    group_name          VARCHAR(255),

    -- Subscriber info (may differ from patient)
    subscriber_name     VARCHAR(200),
    subscriber_id       VARCHAR(50),
    subscriber_dob      DATE,
    relationship_to_subscriber VARCHAR(30) NOT NULL DEFAULT 'self',

    -- Coverage ordering for COB
    coverage_order      INTEGER NOT NULL DEFAULT 1, -- 1=primary, 2=secondary, 3=tertiary

    -- Coverage period
    start_date          DATE NOT NULL,
    end_date            DATE,
    termination_reason  VARCHAR(50),

    -- Benefit reference info (manually entered, not authoritative)
    copay_primary_care  DECIMAL(10, 2),
    copay_specialist    DECIMAL(10, 2),
    copay_emergency     DECIMAL(10, 2),
    deductible          DECIMAL(10, 2),
    out_of_pocket_max   DECIMAL(10, 2),

    -- Card images (S3 keys)
    card_front_image_key VARCHAR(500),
    card_back_image_key  VARCHAR(500),

    -- Authorization
    prior_auth_phone    VARCHAR(50),
    payer_website       VARCHAR(500),

    -- Status
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_verified_at    TIMESTAMP WITH TIME ZONE,
    verification_status VARCHAR(50), -- verified, unverified, failed, pending

    -- Notes
    notes               TEXT,

    -- Audit
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_by          VARCHAR(50),
    updated_by          VARCHAR(50)
);

-- Indexes
CREATE INDEX idx_insurance_patient ON insurance_coverages (patient_id);
CREATE INDEX idx_insurance_patient_order ON insurance_coverages (patient_id, coverage_order)
    WHERE is_active = TRUE;
CREATE INDEX idx_insurance_payer ON insurance_coverages (payer_id);
CREATE INDEX idx_insurance_member ON insurance_coverages (member_id);
CREATE INDEX idx_insurance_active ON insurance_coverages (is_active)
    WHERE is_active = TRUE;

-- We probably should have a unique constraint on (patient_id, coverage_order)
-- where is_active = true, but we didn't add it initially and now there's
-- duplicate data in prod that would violate it. The app layer handles this
-- check instead. (PLAT-7200)
--
-- TODO: clean up duplicate active coverages and add constraint:
-- CREATE UNIQUE INDEX uq_insurance_patient_order_active
--     ON insurance_coverages (patient_id, coverage_order)
--     WHERE is_active = TRUE;

-- Updated_at trigger
CREATE TRIGGER tr_insurance_updated_at
    BEFORE UPDATE ON insurance_coverages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMIT;
