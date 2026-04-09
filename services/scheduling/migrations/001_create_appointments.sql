-- Migration: 001_create_appointments
-- Created: 2024-02-10
-- Author: Sarah Kim
-- Description: Appointments table and related structures

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Providers table (denormalized from auth service)
-- TODO: this should pull from the auth service's users table
-- but for now we maintain a separate providers table because
-- we need provider-specific fields (specialty, NPI, etc.)
CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,  -- references auth service user (not enforced across DB boundaries)
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  specialty VARCHAR(100),
  npi_number VARCHAR(20),  -- National Provider Identifier
  organization_id UUID NOT NULL,
  location_id UUID,
  timezone VARCHAR(50) DEFAULT 'America/New_York',
  default_slot_duration INTEGER DEFAULT 30,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_providers_org ON providers (organization_id);
CREATE INDEX idx_providers_user ON providers (user_id);

-- Patients table (denormalized from auth service)
-- Same situation as providers - we keep a local copy
CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  date_of_birth DATE,
  phone_number VARCHAR(20),
  email VARCHAR(255),
  insurance_id VARCHAR(100),
  organization_id UUID NOT NULL,
  timezone VARCHAR(50) DEFAULT 'America/New_York',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_patients_org ON patients (organization_id);
CREATE INDEX idx_patients_user ON patients (user_id);

-- Appointment types
CREATE TYPE appointment_type AS ENUM (
  'initial_consultation', 'follow_up', 'annual_physical',
  'urgent_care', 'telemedicine', 'procedure', 'lab_work',
  'imaging', 'vaccination', 'therapy', 'other'
);

-- Appointment status
CREATE TYPE appointment_status AS ENUM (
  'scheduled', 'confirmed', 'checked_in', 'in_progress',
  'completed', 'cancelled', 'no_show'
);

-- Main appointments table
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  patient_id UUID NOT NULL REFERENCES patients(id),
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  duration_minutes INTEGER NOT NULL,
  type appointment_type NOT NULL DEFAULT 'other',
  status appointment_status NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  reason_for_visit VARCHAR(500),
  is_telemedicine BOOLEAN DEFAULT FALSE,
  telemedicine_link VARCHAR(500),
  room_number VARCHAR(20),
  check_in_time TIMESTAMP WITH TIME ZONE,
  check_out_time TIMESTAMP WITH TIME ZONE,
  cancellation_reason VARCHAR(500),
  cancelled_by UUID,
  -- Billing
  insurance_verified BOOLEAN DEFAULT FALSE,
  copay_amount INTEGER,  -- stored in cents
  copay_collected BOOLEAN DEFAULT FALSE,
  -- Recurring
  recurring_schedule_id UUID,
  series_index INTEGER,
  -- Metadata
  organization_id UUID,
  location_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID,

  -- Constraints
  CONSTRAINT appointments_time_check CHECK (end_time > start_time),
  CONSTRAINT appointments_duration_check CHECK (duration_minutes > 0 AND duration_minutes <= 480)
);

-- Indexes for common query patterns
CREATE INDEX idx_appointments_provider_time ON appointments (provider_id, start_time)
  WHERE status NOT IN ('cancelled');
CREATE INDEX idx_appointments_patient_time ON appointments (patient_id, start_time DESC);
CREATE INDEX idx_appointments_status ON appointments (status)
  WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX idx_appointments_start_time ON appointments (start_time)
  WHERE status IN ('scheduled', 'confirmed');
CREATE INDEX idx_appointments_recurring ON appointments (recurring_schedule_id)
  WHERE recurring_schedule_id IS NOT NULL;

-- Recurring schedules
CREATE TABLE IF NOT EXISTS recurring_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  patient_id UUID NOT NULL REFERENCES patients(id),
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Appointment reminders tracking
-- Used to ensure we don't send duplicate reminders
CREATE TABLE IF NOT EXISTS appointment_reminders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id UUID NOT NULL REFERENCES appointments(id),
  reminder_type VARCHAR(50) NOT NULL,  -- '24h', '2h', '15m'
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(appointment_id, reminder_type)
);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- TODO: add database-level constraint to prevent double-booking
-- This would fix the race condition in the application layer
-- Something like an exclusion constraint using tstzrange:
--
-- ALTER TABLE appointments ADD CONSTRAINT no_provider_overlap
--   EXCLUDE USING gist (
--     provider_id WITH =,
--     tstzrange(start_time, end_time) WITH &&
--   ) WHERE (status NOT IN ('cancelled', 'no_show'));
--
-- But this requires the btree_gist extension and we haven't tested
-- the performance impact on our dataset yet (SCHED-312)
