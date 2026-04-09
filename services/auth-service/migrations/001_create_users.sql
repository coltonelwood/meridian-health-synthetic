-- Migration: 001_create_users
-- Created: 2024-01-15
-- Author: Marcus Chen
-- Description: Initial users table with RBAC support

-- HIPAA Note: This table contains PHI (Protected Health Information)
-- Access must be logged and audited per HIPAA Security Rule

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- User roles enum
-- TODO: migrate to a roles table for dynamic role management
-- For now using an enum is simpler but limits flexibility
CREATE TYPE user_role AS ENUM (
  'super_admin',
  'org_admin',
  'provider',
  'nurse',
  'front_desk',
  'billing_admin',
  'billing_staff',
  'patient',
  'care_coordinator',
  'external_reviewer'
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255),  -- nullable for SSO-only users
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role user_role NOT NULL DEFAULT 'patient',
  permissions JSONB DEFAULT '[]'::jsonb,
  organization_id UUID NOT NULL,
  mfa_enabled BOOLEAN DEFAULT FALSE,
  mfa_secret VARCHAR(255),  -- TODO: encrypt at rest (AUTH-891)
  last_login TIMESTAMP WITH TIME ZONE,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP WITH TIME ZONE,
  password_changed_at TIMESTAMP WITH TIME ZONE,
  password_history JSONB DEFAULT '[]'::jsonb,  -- stores hashed passwords
  is_active BOOLEAN DEFAULT TRUE,
  email_verified BOOLEAN DEFAULT FALSE,
  sso_provider VARCHAR(50),
  sso_external_id VARCHAR(255),
  date_of_birth DATE,
  phone_number VARCHAR(20),
  notification_preferences JSONB DEFAULT '{"email": true, "sms": false, "push": true}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),

  CONSTRAINT users_email_org_unique UNIQUE (email, organization_id)
);

-- Indexes
CREATE INDEX idx_users_email ON users (LOWER(email));
CREATE INDEX idx_users_organization ON users (organization_id);
CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_sso ON users (sso_provider, sso_external_id) WHERE sso_provider IS NOT NULL;
CREATE INDEX idx_users_active ON users (is_active) WHERE is_active = true;

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  refresh_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ip_address INET,
  user_agent TEXT,
  device_id VARCHAR(255),
  client_type VARCHAR(20),
  is_revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions (token) WHERE is_revoked = false;
CREATE INDEX idx_sessions_refresh ON sessions (refresh_token) WHERE is_revoked = false;
CREATE INDEX idx_sessions_user ON sessions (user_id) WHERE is_revoked = false;
CREATE INDEX idx_sessions_expires ON sessions (expires_at) WHERE is_revoked = false;

-- Login history for HIPAA audit trail
CREATE TABLE IF NOT EXISTS login_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  ip_address INET,
  user_agent TEXT,
  logged_in_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  -- TODO: add login result (success/failure/locked) for better audit reporting
  -- TODO: add geolocation data for suspicious login detection
  success BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_login_history_user ON login_history (user_id, logged_in_at DESC);

-- Password reset tokens
-- TODO: currently using JWT for reset tokens (stored nowhere)
-- This table was created for the future when we want single-use tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Row-level security (placeholder - not enforced yet)
-- TODO: implement RLS for multi-tenant isolation
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY users_org_isolation ON users
--   USING (organization_id = current_setting('app.current_org_id')::uuid);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
