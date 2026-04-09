-- Migration: 002_add_availability
-- Created: 2024-03-22
-- Author: Sarah Kim
-- Description: Provider availability slots and overrides

-- Provider weekly availability slots
-- Each row represents a block of time when the provider is available
-- on a given day of the week
CREATE TABLE IF NOT EXISTS availability_slots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_types JSONB DEFAULT '["all"]'::jsonb,  -- which appointment types can be booked
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- A provider can't have overlapping availability on the same day
  -- TODO: this constraint doesn't actually work because it only prevents
  -- exact duplicates, not overlaps. Need an exclusion constraint.
  -- But TIME doesn't support GiST indexing natively...
  CONSTRAINT availability_time_check CHECK (end_time > start_time)
);

CREATE INDEX idx_availability_provider_day ON availability_slots (provider_id, day_of_week)
  WHERE is_active = true;

-- Availability overrides (PTO, holidays, modified hours, etc.)
CREATE TABLE IF NOT EXISTS availability_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  override_date DATE NOT NULL,
  override_type VARCHAR(20) NOT NULL CHECK (override_type IN ('unavailable', 'modified_hours')),
  start_time TIME,  -- null for 'unavailable', required for 'modified_hours'
  end_time TIME,
  reason VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- One override per provider per date
  UNIQUE(provider_id, override_date)
);

CREATE INDEX idx_overrides_provider_date ON availability_overrides (provider_id, override_date);

-- Seed some common holidays as system-wide overrides
-- TODO: these should be configurable per organization
-- Not all orgs observe the same holidays (especially across states)
-- For now, we just leave this as a reminder to implement it properly

-- INSERT INTO availability_overrides (id, provider_id, override_date, override_type, reason)
-- SELECT gen_random_uuid(), p.id, '2025-01-01', 'unavailable', 'New Year''s Day'
-- FROM providers p
-- UNION ALL
-- SELECT gen_random_uuid(), p.id, '2025-07-04', 'unavailable', 'Independence Day'
-- FROM providers p
-- UNION ALL
-- SELECT gen_random_uuid(), p.id, '2025-12-25', 'unavailable', 'Christmas Day'
-- FROM providers p;

-- View: provider daily schedule (combines regular schedule with overrides)
-- This makes it easier to query "what are the hours for provider X on date Y?"
CREATE OR REPLACE VIEW provider_daily_schedule AS
SELECT
  p.id as provider_id,
  p.first_name,
  p.last_name,
  p.timezone,
  d.date as schedule_date,
  EXTRACT(DOW FROM d.date) as day_of_week,
  CASE
    WHEN ao.override_type = 'unavailable' THEN NULL
    WHEN ao.override_type = 'modified_hours' THEN ao.start_time
    ELSE avs.start_time
  END as effective_start_time,
  CASE
    WHEN ao.override_type = 'unavailable' THEN NULL
    WHEN ao.override_type = 'modified_hours' THEN ao.end_time
    ELSE avs.end_time
  END as effective_end_time,
  CASE
    WHEN ao.id IS NOT NULL THEN ao.override_type
    WHEN avs.id IS NOT NULL THEN 'regular'
    ELSE 'no_schedule'
  END as schedule_type,
  ao.reason as override_reason
FROM providers p
CROSS JOIN generate_series(
  CURRENT_DATE,
  CURRENT_DATE + INTERVAL '90 days',
  '1 day'::interval
) as d(date)
LEFT JOIN availability_slots avs ON
  avs.provider_id = p.id
  AND avs.day_of_week = EXTRACT(DOW FROM d.date)
  AND avs.is_active = true
LEFT JOIN availability_overrides ao ON
  ao.provider_id = p.id
  AND ao.override_date = d.date;

-- NOTE: this view uses generate_series which can be slow for large
-- date ranges or many providers. Consider materializing for dashboard queries.
-- TODO: add a materialized version with daily refresh (SCHED-456)
