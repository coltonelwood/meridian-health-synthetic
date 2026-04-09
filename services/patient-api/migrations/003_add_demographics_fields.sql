-- Migration: 003_add_demographics_fields
-- Created: 2024-01-10
-- Author: Platform Team (Marcus D.)
-- Description: Add new demographic fields required by ONC USCDI v3 and CMS reporting
-- Ticket: PLAT-4200
--
-- Background:
-- The 21st Century Cures Act and ONC USCDI v3 require us to capture
-- additional demographic data including:
--   - Sex assigned at birth (separate from administrative gender)
--   - Gender identity (SOGI data)
--   - Sexual orientation (SOGI data)
--   - Race (multiple selections, OMB categories)
--   - Ethnicity (OMB categories)
--   - Marital status
--   - Religion
--
-- Some of these fields existed before but as free text. This migration
-- adds properly typed columns and migrates existing data where possible.

BEGIN;

-- New demographic columns
ALTER TABLE patients
    ADD COLUMN IF NOT EXISTS sex_assigned_at_birth VARCHAR(50),
    ADD COLUMN IF NOT EXISTS gender_identity VARCHAR(100),
    ADD COLUMN IF NOT EXISTS sexual_orientation VARCHAR(100),
    ADD COLUMN IF NOT EXISTS race JSONB, -- array of race codes
    ADD COLUMN IF NOT EXISTS ethnicity VARCHAR(100),
    ADD COLUMN IF NOT EXISTS marital_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS religion VARCHAR(100);

-- Migrate existing gender data to sex_assigned_at_birth where reasonable
-- This is a best-guess migration - clinical staff will need to verify
UPDATE patients
SET sex_assigned_at_birth = CASE
    WHEN gender = 'male' OR gender = 'M' THEN 'male'
    WHEN gender = 'female' OR gender = 'F' THEN 'female'
    ELSE NULL
END
WHERE sex_assigned_at_birth IS NULL;

-- Normalize legacy gender values
-- Old system used M/F/U, new standard uses male/female/other/unknown
UPDATE patients SET gender = 'male' WHERE gender = 'M';
UPDATE patients SET gender = 'female' WHERE gender = 'F';
UPDATE patients SET gender = 'unknown' WHERE gender = 'U';

-- We had a "race" free-text field in an older version of the schema
-- that was removed. If there's a race_text column, migrate it.
-- (This might not exist in all environments)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'patients' AND column_name = 'race_text'
    ) THEN
        UPDATE patients
        SET race = jsonb_build_array(
            CASE
                WHEN LOWER(race_text) LIKE '%white%' OR LOWER(race_text) LIKE '%caucasian%' THEN 'white'
                WHEN LOWER(race_text) LIKE '%black%' OR LOWER(race_text) LIKE '%african%' THEN 'black'
                WHEN LOWER(race_text) LIKE '%asian%' THEN 'asian'
                WHEN LOWER(race_text) LIKE '%native%' OR LOWER(race_text) LIKE '%indian%' THEN 'native-american'
                WHEN LOWER(race_text) LIKE '%pacific%' OR LOWER(race_text) LIKE '%hawaiian%' THEN 'pacific-islander'
                ELSE 'other'
            END
        )
        WHERE race IS NULL AND race_text IS NOT NULL AND race_text != '';

        -- Don't drop the old column yet - keep for reference
        -- ALTER TABLE patients DROP COLUMN race_text;
    END IF;
END $$;

-- Index on race for reporting queries (GIN index for JSONB)
CREATE INDEX IF NOT EXISTS idx_patients_race ON patients USING gin (race);
CREATE INDEX IF NOT EXISTS idx_patients_ethnicity ON patients (ethnicity);
CREATE INDEX IF NOT EXISTS idx_patients_language ON patients (preferred_language);

-- Add comment for documentation
COMMENT ON COLUMN patients.sex_assigned_at_birth IS 'Sex assigned at birth - ONC USCDI v3 requirement, separate from administrative gender';
COMMENT ON COLUMN patients.gender_identity IS 'Patient self-reported gender identity - SOGI data per Meaningful Use Stage 3';
COMMENT ON COLUMN patients.sexual_orientation IS 'Patient self-reported sexual orientation - SOGI data per Meaningful Use Stage 3';
COMMENT ON COLUMN patients.race IS 'JSON array of OMB race category codes - supports multiple selections';
COMMENT ON COLUMN patients.ethnicity IS 'OMB ethnicity category: hispanic-or-latino, not-hispanic-or-latino, unknown';

COMMIT;
