/**
 * Resource Mapping
 *
 * Maps between our internal IDs and FHIR resource IDs.
 * FHIR resource IDs should be server-assigned and opaque,
 * but we decided to use a mapping table instead of exposing
 * our internal UUIDs directly. This way we can:
 * - Change internal ID schemes without breaking FHIR URLs
 * - Map multiple internal resources to one FHIR resource
 * - Track which internal systems contribute to each FHIR resource
 *
 * In practice, this mapping layer adds complexity and we probably
 * should have just used the internal IDs as FHIR IDs.
 * But here we are.
 */

export interface ResourceMapping {
  id: string;
  fhir_resource_type: FHIRResourceType;
  fhir_resource_id: string;
  internal_resource_type: string;
  internal_resource_id: string;
  internal_source_system: string; // which internal service owns this
  version: number;
  last_synced_at: Date;
  created_at: Date;
  updated_at: Date;
}

export type FHIRResourceType =
  | 'Patient'
  | 'Practitioner'
  | 'Organization'
  | 'Condition'
  | 'Observation'
  | 'Encounter'
  | 'MedicationRequest'
  | 'AllergyIntolerance'
  | 'Immunization'
  | 'DiagnosticReport'
  | 'Procedure'
  | 'CarePlan'
  | 'DocumentReference'
  | 'Coverage'
  | 'Claim'
  | 'ExplanationOfBenefit';

// We only actually support these resource types right now.
// The rest are in the type union for future use.
export const SUPPORTED_RESOURCE_TYPES: FHIRResourceType[] = [
  'Patient',
  'Practitioner',
  'Condition',
  'Observation',
  'Encounter',
  // 'MedicationRequest', // partially implemented, not ready for production
  // 'AllergyIntolerance', // TODO: implement (PLAT-8234)
  // 'Coverage', // TODO: need insurance model mapping
];

export interface ResourceVersion {
  resource_type: FHIRResourceType;
  resource_id: string;
  version: number;
  data_hash: string; // MD5 of the FHIR JSON, used for ETag
  modified_at: Date;
}
