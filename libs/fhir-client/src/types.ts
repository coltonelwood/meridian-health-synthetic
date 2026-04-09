/**
 * FHIR R4 TypeScript type definitions.
 *
 * INCOMPLETE: This only covers the resources we currently use.
 * We should eventually switch to @types/fhir or generate types
 * from the FHIR spec, but for now manual types give us better
 * control over which fields we support.
 *
 * Missing resources (add as needed):
 * - AllergyIntolerance
 * - Procedure
 * - DiagnosticReport
 * - Immunization
 * - Medication
 * - MedicationRequest
 * - Encounter (partially done)
 * - Claim (FHIR Claim, not our internal claim model)
 * - ExplanationOfBenefit
 * - Coverage
 */

// --- Base Types --------------------------------------------------------------

export interface FHIRResource {
  resourceType: string;
  id?: string;
  meta?: FHIRMeta;
}

export interface FHIRMeta {
  versionId?: string;
  lastUpdated?: string;
  profile?: string[];
  tag?: FHIRCoding[];
}

export interface FHIRBundle<T extends FHIRResource> {
  resourceType: 'Bundle';
  type: 'searchset' | 'transaction' | 'transaction-response' | 'batch' | 'collection';
  total?: number;
  link?: FHIRBundleLink[];
  entry?: FHIRBundleEntry<T>[];
}

export interface FHIRBundleLink {
  relation: 'self' | 'next' | 'previous' | 'first' | 'last';
  url: string;
}

export interface FHIRBundleEntry<T extends FHIRResource> {
  fullUrl?: string;
  resource: T;
  request?: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
  };
  response?: {
    status: string;
    location?: string;
  };
}

export interface FHIROperationOutcome {
  resourceType: 'OperationOutcome';
  issue: FHIRIssue[];
}

export interface FHIRIssue {
  severity: 'fatal' | 'error' | 'warning' | 'information';
  code: string;
  diagnostics?: string;
  details?: {
    text?: string;
    coding?: FHIRCoding[];
  };
}

// --- Common Data Types -------------------------------------------------------

export interface FHIRCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FHIRCodeableConcept {
  coding?: FHIRCoding[];
  text?: string;
}

export interface FHIRIdentifier {
  use?: 'usual' | 'official' | 'temp' | 'secondary' | 'old';
  type?: FHIRCodeableConcept;
  system?: string;
  value?: string;
  period?: FHIRPeriod;
}

export interface FHIRHumanName {
  use?: 'usual' | 'official' | 'temp' | 'nickname' | 'anonymous' | 'old' | 'maiden';
  text?: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
}

export interface FHIRAddress {
  use?: 'home' | 'work' | 'temp' | 'old' | 'billing';
  type?: 'postal' | 'physical' | 'both';
  text?: string;
  line?: string[];
  city?: string;
  district?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface FHIRContactPoint {
  system?: 'phone' | 'fax' | 'email' | 'pager' | 'url' | 'sms' | 'other';
  value?: string;
  use?: 'home' | 'work' | 'temp' | 'old' | 'mobile';
  rank?: number;
}

export interface FHIRPeriod {
  start?: string;
  end?: string;
}

export interface FHIRReference {
  reference?: string;
  type?: string;
  display?: string;
}

export interface FHIRQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

// --- Patient Resource --------------------------------------------------------

export interface FHIRPatient extends FHIRResource {
  resourceType: 'Patient';
  identifier?: FHIRIdentifier[];
  active?: boolean;
  name?: FHIRHumanName[];
  telecom?: FHIRContactPoint[];
  gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string;
  deceasedBoolean?: boolean;
  deceasedDateTime?: string;
  address?: FHIRAddress[];
  maritalStatus?: FHIRCodeableConcept;
  communication?: Array<{
    language: FHIRCodeableConcept;
    preferred?: boolean;
  }>;
  generalPractitioner?: FHIRReference[];
  managingOrganization?: FHIRReference;
}

// --- Condition Resource ------------------------------------------------------

export interface FHIRCondition extends FHIRResource {
  resourceType: 'Condition';
  clinicalStatus?: FHIRCodeableConcept;
  verificationStatus?: FHIRCodeableConcept;
  category?: FHIRCodeableConcept[];
  severity?: FHIRCodeableConcept;
  code?: FHIRCodeableConcept;
  bodySite?: FHIRCodeableConcept[];
  subject: FHIRReference;
  onsetDateTime?: string;
  onsetPeriod?: FHIRPeriod;
  abatementDateTime?: string;
  recordedDate?: string;
  recorder?: FHIRReference;
  note?: Array<{ text: string }>;
}

// --- Observation Resource ----------------------------------------------------

export interface FHIRObservation extends FHIRResource {
  resourceType: 'Observation';
  status: 'registered' | 'preliminary' | 'final' | 'amended' | 'corrected' | 'cancelled';
  category?: FHIRCodeableConcept[];
  code: FHIRCodeableConcept;
  subject?: FHIRReference;
  effectiveDateTime?: string;
  effectivePeriod?: FHIRPeriod;
  valueQuantity?: FHIRQuantity;
  valueCodeableConcept?: FHIRCodeableConcept;
  valueString?: string;
  interpretation?: FHIRCodeableConcept[];
  referenceRange?: Array<{
    low?: FHIRQuantity;
    high?: FHIRQuantity;
    type?: FHIRCodeableConcept;
    text?: string;
  }>;
  component?: Array<{
    code: FHIRCodeableConcept;
    valueQuantity?: FHIRQuantity;
    valueString?: string;
  }>;
}

// TODO: Add these resources as we need them:
// - Encounter
// - Practitioner
// - Organization
// - Location
// - Appointment
// - Coverage
// - Claim
// - ExplanationOfBenefit
