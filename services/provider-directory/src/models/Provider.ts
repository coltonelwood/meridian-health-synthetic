/**
 * Provider model
 *
 * Represents a healthcare provider in the directory.
 * Maps to both the providers table in Postgres and the providers index in ES.
 *
 * NOTE: We have a weird situation where some providers have multiple NPIs
 * (Type 1 individual + Type 2 organizational). The data model doesn't handle
 * this well - we just store the primary NPI and have a separate table for
 * secondary NPIs. This should probably be refactored but it's low priority.
 * - Sarah, 2024-06
 */

export enum ProviderType {
  INDIVIDUAL = 'individual',
  ORGANIZATION = 'organization',
}

export enum ProviderStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
  PENDING_VERIFICATION = 'pending_verification',
  // added for the state board integration - not sure if we actually use this
  UNDER_REVIEW = 'under_review',
}

export enum CredentialType {
  MD = 'MD',
  DO = 'DO',
  NP = 'NP',
  PA = 'PA',
  PhD = 'PhD',
  PsyD = 'PsyD',
  LCSW = 'LCSW',
  RN = 'RN',
  DDS = 'DDS',
  DMD = 'DMD',
  OD = 'OD',
  DPM = 'DPM',
  DC = 'DC',
  // there are more but these cover 95% of our providers
}

export interface ProviderAddress {
  id?: string;
  address_line_1: string;
  address_line_2?: string;
  city: string;
  state: string;
  zip_code: string;
  // some old records have 5-digit zips, some have ZIP+4
  // we normalize on insert but there's legacy data that hasn't been cleaned up
  zip_plus_4?: string;
  county?: string;
  country: string;
  address_type: 'practice' | 'mailing' | 'billing';
  latitude?: number;
  longitude?: number;
  // geocoding status - we use Google Maps API to geocode
  geocoded: boolean;
  geocoded_at?: Date;
  phone?: string;
  fax?: string;
  // office hours stored as JSON because the schema kept changing
  office_hours?: Record<string, { open: string; close: string; closed?: boolean }>;
  is_primary: boolean;
  is_accepting_patients_at_location?: boolean;
}

export interface NetworkAffiliation {
  network_id: string;
  network_name: string;
  tier: 'in_network' | 'out_of_network' | 'preferred';
  effective_date: string; // ISO date string
  termination_date?: string;
  contract_type?: string;
}

export interface ProviderSpecialty {
  taxonomy_code: string;
  specialty_name: string;
  is_primary: boolean;
  board_certified: boolean;
  certification_date?: string;
  // NUCC taxonomy codes are hierarchical:
  // e.g., 207R00000X = Internal Medicine, 207RC0000X = Cardiovascular Disease
  classification?: string;
  specialization?: string;
}

export interface Provider {
  id: string;
  npi: string;
  // NPI type 1 = individual, type 2 = organization
  npi_type: 1 | 2;
  provider_type: ProviderType;
  status: ProviderStatus;

  // Name fields - for individuals
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  suffix?: string;
  name_prefix?: string; // Dr., etc.

  // For organizations
  organization_name?: string;

  // display name is computed but we cache it because it's used everywhere
  display_name: string;

  credentials: CredentialType[];
  gender?: 'M' | 'F' | 'X'; // X was added later for non-binary providers

  // Specialties
  specialties: ProviderSpecialty[];
  primary_specialty?: string; // denormalized for quick access

  // Addresses
  addresses: ProviderAddress[];

  // Network affiliations
  network_affiliations: NetworkAffiliation[];

  // Practice info
  accepting_new_patients: boolean;
  telehealth_available: boolean;
  languages: string[];

  // Contact
  phone?: string;
  email?: string;
  website?: string;

  // Bio / about
  bio?: string;
  education?: Array<{
    institution: string;
    degree: string;
    year?: number;
  }>;

  // Ratings (from patient satisfaction surveys)
  rating?: number; // 1-5
  review_count?: number;

  // Group/practice affiliation
  group_practice_id?: string;
  group_practice_name?: string;

  // Metadata
  created_at: Date;
  updated_at: Date;
  last_verified_at?: Date;
  // When was this provider last synced from the NPI registry
  npi_registry_synced_at?: Date;
  // External source system
  source_system?: string;
  source_id?: string;

  // soft delete
  deleted_at?: Date;
}

// For creating a new provider
export type CreateProviderInput = Omit<Provider, 'id' | 'created_at' | 'updated_at' | 'display_name'> & {
  display_name?: string;
};

// For updating - everything is optional
export type UpdateProviderInput = Partial<CreateProviderInput>;

// Search result from ES
export interface ProviderSearchResult {
  provider: Provider;
  score: number;
  distance_miles?: number;
  highlights?: Record<string, string[]>;
}

export interface ProviderSearchResponse {
  results: ProviderSearchResult[];
  total: number;
  page: number;
  page_size: number;
  took_ms: number;
  // was this served from ES or postgres fallback?
  source: 'elasticsearch' | 'postgres';
}
