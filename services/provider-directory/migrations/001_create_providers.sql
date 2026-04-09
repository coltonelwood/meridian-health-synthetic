-- Migration: 001_create_providers
-- Created: 2024-03-15
-- Author: sarah.chen@meridianhealth.io
--
-- Provider directory tables
-- NOTE: We considered using a single JSONB column for addresses and specialties
-- but decided against it because we need to query on those fields efficiently.
-- The join performance is fine with proper indexes.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- We wanted to use PostGIS for geo queries but the managed Postgres on AWS
-- didn't have it enabled and IT said it would take 2 weeks to get it added.
-- So we're doing geo math in the application layer for now.
-- CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS providers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    npi VARCHAR(10) NOT NULL,
    npi_type SMALLINT DEFAULT 1 CHECK (npi_type IN (1, 2)),
    provider_type VARCHAR(20) NOT NULL DEFAULT 'individual',
    status VARCHAR(30) NOT NULL DEFAULT 'pending_verification',

    -- Individual name fields
    first_name VARCHAR(100),
    middle_name VARCHAR(100),
    last_name VARCHAR(100),
    suffix VARCHAR(20),
    name_prefix VARCHAR(20),

    -- Organization name
    organization_name VARCHAR(255),

    -- Cached display name
    display_name VARCHAR(300) NOT NULL,

    -- Credentials stored as text array
    credentials TEXT[] DEFAULT '{}',
    gender CHAR(1),

    -- Practice info
    accepting_new_patients BOOLEAN DEFAULT true,
    telehealth_available BOOLEAN DEFAULT false,
    languages TEXT[] DEFAULT '{en}',

    -- Contact
    phone VARCHAR(20),
    email VARCHAR(255),
    website VARCHAR(500),

    -- Bio/about text
    bio TEXT,

    -- Ratings
    rating DECIMAL(3,2),
    review_count INTEGER DEFAULT 0,

    -- Group practice
    group_practice_id UUID,
    group_practice_name VARCHAR(255),

    -- Source tracking
    source_system VARCHAR(50),
    source_id VARCHAR(100),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_verified_at TIMESTAMP WITH TIME ZONE,
    npi_registry_synced_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT unique_npi_active UNIQUE (npi) -- this doesn't handle soft deletes well, see below
);

-- We realized the unique constraint above doesn't work with soft deletes
-- because a deleted provider would block re-adding with same NPI.
-- The "right" fix is a partial unique index:
-- CREATE UNIQUE INDEX unique_active_npi ON providers (npi) WHERE deleted_at IS NULL;
-- But we haven't applied this migration yet because we need to clean up
-- some duplicate data first. TODO: PLAT-5890

CREATE INDEX idx_providers_npi ON providers (npi);
CREATE INDEX idx_providers_status ON providers (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_providers_name ON providers (last_name, first_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_providers_display_name ON providers (display_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_providers_group ON providers (group_practice_id) WHERE group_practice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_addresses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    address_line_1 VARCHAR(255) NOT NULL,
    address_line_2 VARCHAR(255),
    city VARCHAR(100) NOT NULL,
    state CHAR(2) NOT NULL,
    zip_code VARCHAR(10) NOT NULL,
    zip_plus_4 VARCHAR(4),
    county VARCHAR(100),
    country VARCHAR(3) DEFAULT 'US',
    address_type VARCHAR(20) DEFAULT 'practice',
    latitude DECIMAL(10, 7),
    longitude DECIMAL(10, 7),
    geocoded BOOLEAN DEFAULT false,
    geocoded_at TIMESTAMP WITH TIME ZONE,
    phone VARCHAR(20),
    fax VARCHAR(20),
    office_hours JSONB DEFAULT '{}',
    is_primary BOOLEAN DEFAULT false,
    is_accepting_patients_at_location BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_provider_addresses_provider ON provider_addresses (provider_id);
CREATE INDEX idx_provider_addresses_location ON provider_addresses (latitude, longitude)
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
CREATE INDEX idx_provider_addresses_state_city ON provider_addresses (state, city);
CREATE INDEX idx_provider_addresses_zip ON provider_addresses (zip_code);

CREATE TABLE IF NOT EXISTS provider_specialties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    taxonomy_code VARCHAR(15) NOT NULL,
    specialty_name VARCHAR(200) NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    board_certified BOOLEAN DEFAULT false,
    certification_date DATE,
    classification VARCHAR(200),
    specialization VARCHAR(200),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_provider_specialties_provider ON provider_specialties (provider_id);
CREATE INDEX idx_provider_specialties_taxonomy ON provider_specialties (taxonomy_code);
CREATE INDEX idx_provider_specialties_name ON provider_specialties (specialty_name);

CREATE TABLE IF NOT EXISTS provider_network_affiliations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    network_id UUID NOT NULL,
    tier VARCHAR(30) DEFAULT 'in_network',
    effective_date DATE NOT NULL,
    termination_date DATE,
    contract_type VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_provider_networks_provider ON provider_network_affiliations (provider_id);
CREATE INDEX idx_provider_networks_network ON provider_network_affiliations (network_id);
CREATE INDEX idx_provider_networks_active ON provider_network_affiliations (provider_id, network_id)
    WHERE termination_date IS NULL OR termination_date > NOW();

-- Networks reference table (should probably be in its own service but it's here for now)
CREATE TABLE IF NOT EXISTS networks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    payer_id VARCHAR(50),
    network_type VARCHAR(50), -- HMO, PPO, EPO, etc.
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Specialty taxonomy reference table (NUCC codes)
CREATE TABLE IF NOT EXISTS specialty_taxonomy (
    taxonomy_code VARCHAR(15) PRIMARY KEY,
    specialty_name VARCHAR(200) NOT NULL,
    classification VARCHAR(200),
    specialization VARCHAR(200),
    is_common BOOLEAN DEFAULT false,
    display_order INTEGER DEFAULT 999,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed some common specialties
INSERT INTO specialty_taxonomy (taxonomy_code, specialty_name, classification, specialization, is_common, display_order) VALUES
('207R00000X', 'Internal Medicine', 'Allopathic & Osteopathic Physicians', 'Internal Medicine', true, 1),
('207Q00000X', 'Family Medicine', 'Allopathic & Osteopathic Physicians', 'Family Medicine', true, 2),
('208D00000X', 'General Practice', 'Allopathic & Osteopathic Physicians', 'General Practice', true, 3),
('207RC0000X', 'Cardiovascular Disease', 'Allopathic & Osteopathic Physicians', 'Internal Medicine', true, 4),
('2084P0800X', 'Psychiatry', 'Allopathic & Osteopathic Physicians', 'Psychiatry & Neurology', true, 5),
('207V00000X', 'Obstetrics & Gynecology', 'Allopathic & Osteopathic Physicians', 'Obstetrics & Gynecology', true, 6),
('208600000X', 'Surgery', 'Allopathic & Osteopathic Physicians', 'Surgery', true, 7),
('207X00000X', 'Orthopaedic Surgery', 'Allopathic & Osteopathic Physicians', 'Orthopaedic Surgery', true, 8),
('207RG0100X', 'Gastroenterology', 'Allopathic & Osteopathic Physicians', 'Internal Medicine', true, 9),
('207RE0101X', 'Endocrinology', 'Allopathic & Osteopathic Physicians', 'Internal Medicine', true, 10),
('207RN0300X', 'Nephrology', 'Allopathic & Osteopathic Physicians', 'Internal Medicine', true, 11),
('2086S0129X', 'Vascular Surgery', 'Allopathic & Osteopathic Physicians', 'Surgery', true, 12),
('207RP1001X', 'Pulmonary Disease', 'Allopathic & Osteopathic Physicians', 'Internal Medicine', true, 13),
('207Y00000X', 'Otolaryngology', 'Allopathic & Osteopathic Physicians', 'Otolaryngology', true, 14),
('207T00000X', 'Neurological Surgery', 'Allopathic & Osteopathic Physicians', 'Neurological Surgery', true, 15),
('363L00000X', 'Nurse Practitioner', 'Physician Assistants & Advanced Practice Nursing Providers', NULL, true, 16),
('363A00000X', 'Physician Assistant', 'Physician Assistants & Advanced Practice Nursing Providers', NULL, true, 17),
('1223G0001X', 'General Dentistry', 'Dental Providers', 'Dentist', true, 18)
ON CONFLICT (taxonomy_code) DO NOTHING;
