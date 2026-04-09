-- Migration: 001_create_patients
-- Created: 2023-06-15
-- Author: Platform Team
-- Description: Initial patient table creation
--
-- NOTE: This was our first migration for the patient service.
-- Some column names don't follow our current naming convention
-- because we hadn't standardized yet. Don't rename them now
-- because too many things depend on the current names.

BEGIN;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE patients (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mrn             VARCHAR(20) NOT NULL,
    first_name      VARCHAR(100) NOT NULL,
    middle_name     VARCHAR(100),
    last_name       VARCHAR(100) NOT NULL,
    prefix          VARCHAR(20),
    suffix          VARCHAR(20),
    date_of_birth   DATE NOT NULL,
    date_of_death   DATE,
    is_deceased     BOOLEAN NOT NULL DEFAULT FALSE,
    gender          VARCHAR(20) NOT NULL,

    -- SSN is encrypted using AES-256-GCM
    -- The encrypted value is longer than the original 9 digits
    -- Format: iv:authTag:ciphertext (hex encoded)
    ssn_encrypted   VARCHAR(255),

    -- Contact info
    home_phone      VARCHAR(20),
    mobile_phone    VARCHAR(20),
    work_phone      VARCHAR(20),
    email           VARCHAR(255),
    preferred_contact_method VARCHAR(20) DEFAULT 'phone',

    -- Emergency contact (single for now)
    emergency_contact_name          VARCHAR(200),
    emergency_contact_relationship  VARCHAR(50),
    emergency_contact_phone         VARCHAR(20),

    -- Language
    preferred_language VARCHAR(10) DEFAULT 'en',

    -- Clinical references
    primary_care_provider_id VARCHAR(50),
    primary_facility_id      VARCHAR(50),

    -- Status
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    merged_into_id  VARCHAR(50),

    -- Source tracking
    source_system   VARCHAR(50),
    external_id     VARCHAR(255),

    -- Audit fields
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(50),
    updated_by      VARCHAR(50),

    -- Constraints
    CONSTRAINT uq_patients_mrn UNIQUE (mrn)
);

-- Indexes for common query patterns
CREATE INDEX idx_patients_last_first_name ON patients (last_name, first_name);
CREATE INDEX idx_patients_dob ON patients (date_of_birth);
CREATE INDEX idx_patients_status ON patients (status) WHERE is_active = TRUE;
CREATE INDEX idx_patients_source ON patients (source_system, external_id);

-- Partial index for active patients (most queries filter on this)
CREATE INDEX idx_patients_active ON patients (id) WHERE is_active = TRUE;

-- Full-text search index
-- TODO: consider using pg_trgm extension for fuzzy search instead
CREATE INDEX idx_patients_name_search ON patients
    USING gin (to_tsvector('english', first_name || ' ' || last_name));

-- Patient addresses table
CREATE TABLE patient_addresses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    address_type    VARCHAR(20) NOT NULL DEFAULT 'home',
    line1           VARCHAR(255) NOT NULL,
    line2           VARCHAR(255),
    city            VARCHAR(100) NOT NULL,
    state           VARCHAR(2) NOT NULL,
    zip_code        VARCHAR(10) NOT NULL,
    country         VARCHAR(2) NOT NULL DEFAULT 'US',
    county          VARCHAR(50),
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    latitude        DECIMAL(10, 7),
    longitude       DECIMAL(10, 7),
    is_geocoded     BOOLEAN NOT NULL DEFAULT FALSE,
    start_date      DATE,
    end_date        DATE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_addresses_patient ON patient_addresses (patient_id);
CREATE INDEX idx_addresses_zip ON patient_addresses (zip_code);

-- Audit log table for HIPAA compliance
-- Every access to patient PHI is logged here
CREATE TABLE patient_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    event_id        VARCHAR(100) NOT NULL,
    event_type      VARCHAR(50) NOT NULL,
    action          VARCHAR(20) NOT NULL,
    outcome         VARCHAR(20) NOT NULL,
    user_id         VARCHAR(50) NOT NULL,
    user_email      VARCHAR(255),
    user_roles      TEXT[], -- postgres array
    organization_id VARCHAR(50),
    ip_address      VARCHAR(45), -- supports IPv6
    user_agent      TEXT,
    http_method     VARCHAR(10),
    endpoint        TEXT,
    resource_type   VARCHAR(50),
    resource_id     VARCHAR(100),
    response_status INTEGER,
    response_time   INTEGER, -- milliseconds
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Audit log indexes - these are important for compliance queries
CREATE INDEX idx_audit_user ON patient_audit_log (user_id, created_at);
CREATE INDEX idx_audit_resource ON patient_audit_log (resource_type, resource_id, created_at);
CREATE INDEX idx_audit_date ON patient_audit_log (created_at);

-- Don't allow deletion of audit records (HIPAA retention)
-- This is enforced by not granting DELETE on this table to the app user
-- but we also add a trigger as defense in depth
CREATE OR REPLACE FUNCTION prevent_audit_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Deletion of audit records is not permitted (HIPAA compliance)';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_prevent_audit_delete
    BEFORE DELETE ON patient_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_delete();

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_patients_updated_at
    BEFORE UPDATE ON patients
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_addresses_updated_at
    BEFORE UPDATE ON patient_addresses
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMIT;
