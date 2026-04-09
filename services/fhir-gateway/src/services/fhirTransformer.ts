import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { FHIRResourceType } from '../models/ResourceMapping';

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * FHIR Transformer
 *
 * Transforms between our internal data models and FHIR R4 resources.
 * This is the biggest and most painful file in the FHIR gateway.
 *
 * FHIR resources have specific structures, code systems, and naming
 * conventions that differ from our internal models. For example:
 * - FHIR uses "family" and "given" for names; we use "last_name" and "first_name"
 * - FHIR uses code/system/display tuples; we use flat string fields
 * - FHIR uses references like "Patient/123"; we use plain IDs
 * - FHIR dates can be partial (just year, or year-month); we use full dates
 *
 * Each resource type has its own transform function. They're all slightly
 * different patterns because they were written by different people at
 * different times. Ideally we'd have a consistent mapping DSL but that
 * felt over-engineered for ~5 resource types.
 *
 * Known issues:
 * - Extensions are mostly ignored (we don't map US Core extensions)
 * - CodeableConcept mappings are incomplete - we hardcode the most common
 *   code systems but miss edge cases
 * - The reverse transform (FHIR -> internal) is less tested than the
 *   forward transform (internal -> FHIR)
 * - We don't validate against FHIR profiles (e.g., US Core Patient)
 */

// Common FHIR code systems
const CODE_SYSTEMS = {
  SNOMED: 'http://snomed.info/sct',
  LOINC: 'http://loinc.org',
  ICD10: 'http://hl7.org/fhir/sid/icd-10-cm',
  CPT: 'http://www.ama-assn.org/go/cpt',
  RXNORM: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  NPI: 'http://hl7.org/fhir/sid/us-npi',
  MRN: 'http://meridianhealth.com/fhir/mrn',
  ENCOUNTER_CLASS: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  CONDITION_CLINICAL: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  CONDITION_VERIFICATION: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  OBSERVATION_CATEGORY: 'http://terminology.hl7.org/CodeSystem/observation-category',
};

/**
 * Transform internal data to FHIR resource
 */
export async function transformToFHIR(
  resourceType: FHIRResourceType,
  internalData: any
): Promise<any> {
  switch (resourceType) {
    case 'Patient':
      return transformPatientToFHIR(internalData);
    case 'Practitioner':
      return transformPractitionerToFHIR(internalData);
    case 'Condition':
      return transformConditionToFHIR(internalData);
    case 'Observation':
      return transformObservationToFHIR(internalData);
    case 'Encounter':
      return transformEncounterToFHIR(internalData);
    default:
      getLogger().warn(`No FHIR transform for resource type: ${resourceType}`);
      return null;
  }
}

/**
 * Transform FHIR resource to internal data
 */
export async function transformFromFHIR(
  resourceType: FHIRResourceType,
  fhirResource: any
): Promise<any> {
  switch (resourceType) {
    case 'Patient':
      return transformPatientFromFHIR(fhirResource);
    case 'Practitioner':
      return transformPractitionerFromFHIR(fhirResource);
    case 'Condition':
      return transformConditionFromFHIR(fhirResource);
    case 'Observation':
      return transformObservationFromFHIR(fhirResource);
    case 'Encounter':
      return transformEncounterFromFHIR(fhirResource);
    default:
      throw new Error(`No reverse FHIR transform for resource type: ${resourceType}`);
  }
}

// ============================================================
// PATIENT
// ============================================================

function transformPatientToFHIR(patient: any): any {
  const fhirPatient: any = {
    resourceType: 'Patient',
    id: patient.fhir_id || patient.id,
    meta: {
      versionId: String(patient.version || 1),
      lastUpdated: patient.updated_at || patient.created_at,
      profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
    },
    identifier: [],
    active: patient.status === 'active',
    name: [],
    telecom: [],
    gender: mapGenderToFHIR(patient.gender),
    birthDate: patient.date_of_birth,
    address: [],
  };

  // MRN identifier
  if (patient.mrn) {
    fhirPatient.identifier.push({
      use: 'usual',
      type: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
          code: 'MR',
          display: 'Medical Record Number',
        }],
      },
      system: CODE_SYSTEMS.MRN,
      value: patient.mrn,
    });
  }

  // SSN identifier (if present - we shouldn't expose this broadly)
  // NOTE: debate about whether to include SSN in FHIR responses.
  // Currently included because the state HIE requires it.
  // This should be controlled by a scope/permission.
  // TODO: make SSN inclusion configurable per client/scope (PLAT-8901)
  if (patient.ssn_last_four) {
    fhirPatient.identifier.push({
      use: 'official',
      type: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
          code: 'SS',
          display: 'Social Security Number',
        }],
      },
      system: 'http://hl7.org/fhir/sid/us-ssn',
      // Only last 4 digits
      value: `***-**-${patient.ssn_last_four}`,
    });
  }

  // Name
  const name: any = {
    use: 'official',
    family: patient.last_name,
    given: [patient.first_name],
  };
  if (patient.middle_name) {
    name.given.push(patient.middle_name);
  }
  if (patient.suffix) {
    name.suffix = [patient.suffix];
  }
  if (patient.prefix) {
    name.prefix = [patient.prefix];
  }
  fhirPatient.name.push(name);

  // Previous/maiden name
  if (patient.maiden_name) {
    fhirPatient.name.push({
      use: 'maiden',
      family: patient.maiden_name,
    });
  }

  // Contact info
  if (patient.phone) {
    fhirPatient.telecom.push({
      system: 'phone',
      value: patient.phone,
      use: 'home',
    });
  }
  if (patient.mobile_phone || patient.cell_phone) {
    fhirPatient.telecom.push({
      system: 'phone',
      value: patient.mobile_phone || patient.cell_phone,
      use: 'mobile',
    });
  }
  if (patient.email) {
    fhirPatient.telecom.push({
      system: 'email',
      value: patient.email,
    });
  }

  // Address
  if (patient.address || patient.address_line_1) {
    const addr: any = {
      use: 'home',
      type: 'physical',
      line: [patient.address_line_1 || patient.address],
    };
    if (patient.address_line_2) addr.line.push(patient.address_line_2);
    if (patient.city) addr.city = patient.city;
    if (patient.state) addr.state = patient.state;
    if (patient.zip_code || patient.zip) addr.postalCode = patient.zip_code || patient.zip;
    if (patient.country) addr.country = patient.country;
    fhirPatient.address.push(addr);
  }

  // Deceased
  if (patient.deceased_date) {
    fhirPatient.deceasedDateTime = patient.deceased_date;
  } else if (patient.is_deceased !== undefined) {
    fhirPatient.deceasedBoolean = patient.is_deceased;
  }

  // Marital status
  if (patient.marital_status) {
    fhirPatient.maritalStatus = {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus',
        code: mapMaritalStatus(patient.marital_status),
      }],
    };
  }

  // Language
  if (patient.preferred_language) {
    fhirPatient.communication = [{
      language: {
        coding: [{
          system: 'urn:ietf:bcp:47',
          code: patient.preferred_language,
        }],
      },
      preferred: true,
    }];
  }

  // Race and ethnicity (US Core extensions)
  // These are required by US Core but they're extensions, which is messy
  if (patient.race) {
    fhirPatient.extension = fhirPatient.extension || [];
    fhirPatient.extension.push({
      url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
      extension: [{
        url: 'ombCategory',
        valueCoding: {
          system: 'urn:oid:2.16.840.1.113883.6.238',
          code: mapRaceCode(patient.race),
          display: patient.race,
        },
      }, {
        url: 'text',
        valueString: patient.race,
      }],
    });
  }

  if (patient.ethnicity) {
    fhirPatient.extension = fhirPatient.extension || [];
    fhirPatient.extension.push({
      url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
      extension: [{
        url: 'ombCategory',
        valueCoding: {
          system: 'urn:oid:2.16.840.1.113883.6.238',
          code: mapEthnicityCode(patient.ethnicity),
          display: patient.ethnicity,
        },
      }, {
        url: 'text',
        valueString: patient.ethnicity,
      }],
    });
  }

  return fhirPatient;
}

function transformPatientFromFHIR(fhir: any): any {
  const patient: any = {};

  // Name - use the "official" name or first available
  const officialName = fhir.name?.find((n: any) => n.use === 'official') || fhir.name?.[0];
  if (officialName) {
    patient.last_name = officialName.family;
    patient.first_name = officialName.given?.[0];
    patient.middle_name = officialName.given?.[1];
    patient.suffix = officialName.suffix?.[0];
    patient.prefix = officialName.prefix?.[0];
  }

  patient.gender = mapGenderFromFHIR(fhir.gender);
  patient.date_of_birth = fhir.birthDate;
  patient.status = fhir.active ? 'active' : 'inactive';

  // MRN from identifier
  const mrnIdentifier = fhir.identifier?.find((id: any) =>
    id.type?.coding?.some((c: any) => c.code === 'MR') ||
    id.system === CODE_SYSTEMS.MRN
  );
  if (mrnIdentifier) {
    patient.mrn = mrnIdentifier.value;
  }

  // Contact
  const homePhone = fhir.telecom?.find((t: any) => t.system === 'phone' && t.use === 'home');
  const mobilePhone = fhir.telecom?.find((t: any) => t.system === 'phone' && t.use === 'mobile');
  const email = fhir.telecom?.find((t: any) => t.system === 'email');

  if (homePhone) patient.phone = homePhone.value;
  if (mobilePhone) patient.mobile_phone = mobilePhone.value;
  if (email) patient.email = email.value;

  // Address
  const homeAddress = fhir.address?.find((a: any) => a.use === 'home') || fhir.address?.[0];
  if (homeAddress) {
    patient.address_line_1 = homeAddress.line?.[0];
    patient.address_line_2 = homeAddress.line?.[1];
    patient.city = homeAddress.city;
    patient.state = homeAddress.state;
    patient.zip_code = homeAddress.postalCode;
    patient.country = homeAddress.country;
  }

  // Language
  const preferredComm = fhir.communication?.find((c: any) => c.preferred);
  if (preferredComm) {
    patient.preferred_language = preferredComm.language?.coding?.[0]?.code;
  }

  return patient;
}

// ============================================================
// PRACTITIONER
// ============================================================

function transformPractitionerToFHIR(provider: any): any {
  const fhirPractitioner: any = {
    resourceType: 'Practitioner',
    id: provider.fhir_id || provider.id,
    meta: {
      versionId: String(provider.version || 1),
      lastUpdated: provider.updated_at,
      profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner'],
    },
    identifier: [],
    active: provider.status === 'active',
    name: [],
    telecom: [],
    address: [],
    qualification: [],
  };

  // NPI
  if (provider.npi) {
    fhirPractitioner.identifier.push({
      system: CODE_SYSTEMS.NPI,
      value: provider.npi,
    });
  }

  // Name
  if (provider.organization_name) {
    // This is actually an Organization, not a Practitioner
    // But we map both through this function because our internal model
    // doesn't distinguish cleanly. This is wrong per FHIR spec.
    // TODO: properly map organizations to Organization resources (PLAT-8890)
    fhirPractitioner.name.push({
      text: provider.organization_name,
    });
  } else {
    const name: any = {
      use: 'official',
      family: provider.last_name,
      given: [provider.first_name],
    };
    if (provider.middle_name) name.given.push(provider.middle_name);
    if (provider.suffix) name.suffix = [provider.suffix];
    if (provider.name_prefix) name.prefix = [provider.name_prefix];
    fhirPractitioner.name.push(name);
  }

  // Gender
  if (provider.gender) {
    fhirPractitioner.gender = mapGenderToFHIR(provider.gender);
  }

  // Contact
  if (provider.phone) {
    fhirPractitioner.telecom.push({ system: 'phone', value: provider.phone, use: 'work' });
  }
  if (provider.email) {
    fhirPractitioner.telecom.push({ system: 'email', value: provider.email, use: 'work' });
  }

  // Address (from primary address)
  const primaryAddr = provider.addresses?.find((a: any) => a.is_primary) || provider.addresses?.[0];
  if (primaryAddr) {
    fhirPractitioner.address.push({
      use: 'work',
      line: [primaryAddr.address_line_1, primaryAddr.address_line_2].filter(Boolean),
      city: primaryAddr.city,
      state: primaryAddr.state,
      postalCode: primaryAddr.zip_code,
      country: primaryAddr.country || 'US',
    });
  }

  // Qualifications/credentials
  if (provider.credentials?.length) {
    for (const cred of provider.credentials) {
      fhirPractitioner.qualification.push({
        code: {
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v2-0360',
            code: cred,
            display: cred,
          }],
          text: cred,
        },
      });
    }
  }

  // Specialties are not part of Practitioner in FHIR - they go in PractitionerRole
  // But we include them as an extension because PractitionerRole is a separate
  // resource and most of our consumers expect specialty on the practitioner.
  // This is non-conformant but pragmatic.
  if (provider.specialties?.length) {
    fhirPractitioner.extension = fhirPractitioner.extension || [];
    fhirPractitioner.extension.push({
      url: 'http://meridianhealth.com/fhir/extensions/specialties',
      valueString: provider.specialties.map((s: any) => s.specialty_name || s).join(', '),
    });
  }

  return fhirPractitioner;
}

function transformPractitionerFromFHIR(fhir: any): any {
  const provider: any = {};

  const name = fhir.name?.[0];
  if (name) {
    provider.last_name = name.family;
    provider.first_name = name.given?.[0];
    provider.middle_name = name.given?.[1];
    provider.name_prefix = name.prefix?.[0];
    provider.suffix = name.suffix?.[0];
  }

  const npi = fhir.identifier?.find((id: any) => id.system === CODE_SYSTEMS.NPI);
  if (npi) provider.npi = npi.value;

  if (fhir.gender) provider.gender = mapGenderFromFHIR(fhir.gender);
  provider.status = fhir.active ? 'active' : 'inactive';

  const phone = fhir.telecom?.find((t: any) => t.system === 'phone');
  const email = fhir.telecom?.find((t: any) => t.system === 'email');
  if (phone) provider.phone = phone.value;
  if (email) provider.email = email.value;

  return provider;
}

// ============================================================
// CONDITION
// ============================================================

function transformConditionToFHIR(condition: any): any {
  return {
    resourceType: 'Condition',
    id: condition.fhir_id || condition.id,
    meta: {
      versionId: String(condition.version || 1),
      lastUpdated: condition.updated_at,
    },
    clinicalStatus: {
      coding: [{
        system: CODE_SYSTEMS.CONDITION_CLINICAL,
        code: mapConditionClinicalStatus(condition.status),
      }],
    },
    verificationStatus: {
      coding: [{
        system: CODE_SYSTEMS.CONDITION_VERIFICATION,
        code: mapConditionVerificationStatus(condition.verification_status || 'confirmed'),
      }],
    },
    category: [{
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/condition-category',
        code: condition.category || 'encounter-diagnosis',
        display: condition.category === 'problem-list-item' ? 'Problem List Item' : 'Encounter Diagnosis',
      }],
    }],
    code: {
      coding: [
        condition.icd10_code ? {
          system: CODE_SYSTEMS.ICD10,
          code: condition.icd10_code,
          display: condition.description || condition.name,
        } : null,
        condition.snomed_code ? {
          system: CODE_SYSTEMS.SNOMED,
          code: condition.snomed_code,
          display: condition.description || condition.name,
        } : null,
      ].filter(Boolean),
      text: condition.description || condition.name,
    },
    subject: {
      reference: `Patient/${condition.patient_id}`,
    },
    onsetDateTime: condition.onset_date,
    abatementDateTime: condition.resolved_date,
    recordedDate: condition.recorded_date || condition.created_at,
    note: condition.notes ? [{ text: condition.notes }] : undefined,
  };
}

function transformConditionFromFHIR(fhir: any): any {
  const condition: any = {};

  // Extract ICD-10 code
  const icd10 = fhir.code?.coding?.find((c: any) => c.system === CODE_SYSTEMS.ICD10);
  if (icd10) {
    condition.icd10_code = icd10.code;
    condition.description = icd10.display;
  }

  // Extract SNOMED code
  const snomed = fhir.code?.coding?.find((c: any) => c.system === CODE_SYSTEMS.SNOMED);
  if (snomed) {
    condition.snomed_code = snomed.code;
    if (!condition.description) condition.description = snomed.display;
  }

  if (!condition.description) {
    condition.description = fhir.code?.text;
  }

  condition.onset_date = fhir.onsetDateTime;
  condition.resolved_date = fhir.abatementDateTime;
  condition.status = mapConditionClinicalStatusReverse(
    fhir.clinicalStatus?.coding?.[0]?.code
  );

  const patientRef = fhir.subject?.reference;
  if (patientRef) {
    condition.patient_id = patientRef.replace('Patient/', '');
  }

  return condition;
}

// ============================================================
// OBSERVATION
// ============================================================

function transformObservationToFHIR(observation: any): any {
  const fhirObs: any = {
    resourceType: 'Observation',
    id: observation.fhir_id || observation.id,
    meta: {
      versionId: String(observation.version || 1),
      lastUpdated: observation.updated_at,
    },
    status: observation.status || 'final',
    category: [{
      coding: [{
        system: CODE_SYSTEMS.OBSERVATION_CATEGORY,
        code: observation.category || 'vital-signs',
        display: mapObservationCategoryDisplay(observation.category || 'vital-signs'),
      }],
    }],
    code: {
      coding: [
        observation.loinc_code ? {
          system: CODE_SYSTEMS.LOINC,
          code: observation.loinc_code,
          display: observation.name || observation.description,
        } : null,
      ].filter(Boolean),
      text: observation.name || observation.description,
    },
    subject: {
      reference: `Patient/${observation.patient_id}`,
    },
    effectiveDateTime: observation.effective_date || observation.observation_date,
    issued: observation.created_at,
  };

  // Value - can be different types in FHIR
  if (observation.value !== undefined && observation.value !== null) {
    if (typeof observation.value === 'number') {
      fhirObs.valueQuantity = {
        value: observation.value,
        unit: observation.unit || '',
        system: 'http://unitsofmeasure.org',
        code: observation.unit_code || observation.unit || '',
      };
    } else if (typeof observation.value === 'string') {
      // Could be a coded value or just text
      if (observation.value_code) {
        fhirObs.valueCodeableConcept = {
          coding: [{
            system: observation.value_system || CODE_SYSTEMS.SNOMED,
            code: observation.value_code,
            display: observation.value,
          }],
          text: observation.value,
        };
      } else {
        fhirObs.valueString = observation.value;
      }
    }
  }

  // Reference range
  if (observation.reference_low !== undefined || observation.reference_high !== undefined) {
    fhirObs.referenceRange = [{
      low: observation.reference_low !== undefined ? {
        value: observation.reference_low,
        unit: observation.unit || '',
      } : undefined,
      high: observation.reference_high !== undefined ? {
        value: observation.reference_high,
        unit: observation.unit || '',
      } : undefined,
    }];
  }

  // Interpretation
  if (observation.interpretation) {
    fhirObs.interpretation = [{
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
        code: mapInterpretation(observation.interpretation),
      }],
    }];
  }

  return fhirObs;
}

function transformObservationFromFHIR(fhir: any): any {
  const obs: any = {};

  const loinc = fhir.code?.coding?.find((c: any) => c.system === CODE_SYSTEMS.LOINC);
  if (loinc) {
    obs.loinc_code = loinc.code;
    obs.name = loinc.display;
  }
  if (!obs.name) obs.name = fhir.code?.text;

  obs.status = fhir.status;
  obs.category = fhir.category?.[0]?.coding?.[0]?.code;
  obs.effective_date = fhir.effectiveDateTime;

  if (fhir.valueQuantity) {
    obs.value = fhir.valueQuantity.value;
    obs.unit = fhir.valueQuantity.unit;
  } else if (fhir.valueString) {
    obs.value = fhir.valueString;
  } else if (fhir.valueCodeableConcept) {
    obs.value = fhir.valueCodeableConcept.text;
    obs.value_code = fhir.valueCodeableConcept.coding?.[0]?.code;
  }

  const patientRef = fhir.subject?.reference;
  if (patientRef) {
    obs.patient_id = patientRef.replace('Patient/', '');
  }

  return obs;
}

// ============================================================
// ENCOUNTER
// ============================================================

function transformEncounterToFHIR(encounter: any): any {
  return {
    resourceType: 'Encounter',
    id: encounter.fhir_id || encounter.id,
    meta: {
      versionId: String(encounter.version || 1),
      lastUpdated: encounter.updated_at,
    },
    status: mapEncounterStatus(encounter.status),
    class: {
      system: CODE_SYSTEMS.ENCOUNTER_CLASS,
      code: mapEncounterClass(encounter.encounter_type || encounter.type),
      display: encounter.encounter_type || encounter.type,
    },
    type: encounter.visit_type ? [{
      coding: [{
        // We don't have proper SNOMED codes for visit types
        // Using a local code system
        system: 'http://meridianhealth.com/fhir/visit-types',
        code: encounter.visit_type,
        display: encounter.visit_type,
      }],
    }] : undefined,
    subject: {
      reference: `Patient/${encounter.patient_id}`,
    },
    participant: encounter.provider_id ? [{
      individual: {
        reference: `Practitioner/${encounter.provider_id}`,
      },
    }] : [],
    period: {
      start: encounter.start_time || encounter.appointment_date,
      end: encounter.end_time,
    },
    reasonCode: encounter.reason ? [{
      text: encounter.reason,
    }] : undefined,
    diagnosis: encounter.diagnoses?.map((dx: any) => ({
      condition: {
        reference: `Condition/${dx.condition_id || dx.id}`,
        display: dx.description,
      },
      use: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/diagnosis-role',
          code: dx.is_primary ? 'AD' : 'DD',
        }],
      },
    })),
    location: encounter.facility_name ? [{
      location: {
        display: encounter.facility_name,
      },
    }] : undefined,
  };
}

function transformEncounterFromFHIR(fhir: any): any {
  const encounter: any = {};

  encounter.status = mapEncounterStatusReverse(fhir.status);
  encounter.encounter_type = fhir.class?.display || fhir.class?.code;

  if (fhir.period) {
    encounter.start_time = fhir.period.start;
    encounter.end_time = fhir.period.end;
  }

  const patientRef = fhir.subject?.reference;
  if (patientRef) encounter.patient_id = patientRef.replace('Patient/', '');

  const practitionerRef = fhir.participant?.[0]?.individual?.reference;
  if (practitionerRef) encounter.provider_id = practitionerRef.replace('Practitioner/', '');

  encounter.reason = fhir.reasonCode?.[0]?.text;

  return encounter;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function mapGenderToFHIR(gender: string): string {
  const map: Record<string, string> = {
    'M': 'male', 'Male': 'male', 'male': 'male',
    'F': 'female', 'Female': 'female', 'female': 'female',
    'O': 'other', 'Other': 'other', 'X': 'other',
    'U': 'unknown', 'Unknown': 'unknown',
  };
  return map[gender] || 'unknown';
}

function mapGenderFromFHIR(gender: string): string {
  const map: Record<string, string> = {
    'male': 'M', 'female': 'F', 'other': 'O', 'unknown': 'U',
  };
  return map[gender] || 'U';
}

function mapMaritalStatus(status: string): string {
  const map: Record<string, string> = {
    'single': 'S', 'married': 'M', 'divorced': 'D',
    'widowed': 'W', 'separated': 'L', 'partner': 'T',
  };
  return map[status.toLowerCase()] || 'UNK';
}

function mapRaceCode(race: string): string {
  // OMB race codes
  const map: Record<string, string> = {
    'White': '2106-3',
    'Black or African American': '2054-5',
    'Asian': '2028-9',
    'American Indian or Alaska Native': '1002-5',
    'Native Hawaiian or Other Pacific Islander': '2076-8',
    'Other': '2131-1',
  };
  return map[race] || '2131-1'; // default to Other
}

function mapEthnicityCode(ethnicity: string): string {
  const map: Record<string, string> = {
    'Hispanic or Latino': '2135-2',
    'Not Hispanic or Latino': '2186-5',
  };
  return map[ethnicity] || '2186-5';
}

function mapConditionClinicalStatus(status: string): string {
  const map: Record<string, string> = {
    'active': 'active', 'resolved': 'resolved', 'inactive': 'inactive',
    'remission': 'remission', 'recurrence': 'recurrence',
  };
  return map[status] || 'active';
}

function mapConditionClinicalStatusReverse(code: string): string {
  return code || 'active'; // FHIR codes map 1:1 to ours
}

function mapConditionVerificationStatus(status: string): string {
  const map: Record<string, string> = {
    'confirmed': 'confirmed', 'provisional': 'provisional',
    'differential': 'differential', 'unconfirmed': 'unconfirmed',
    'refuted': 'refuted', 'entered-in-error': 'entered-in-error',
  };
  return map[status] || 'confirmed';
}

function mapObservationCategoryDisplay(code: string): string {
  const map: Record<string, string> = {
    'vital-signs': 'Vital Signs',
    'laboratory': 'Laboratory',
    'imaging': 'Imaging',
    'procedure': 'Procedure',
    'survey': 'Survey',
    'social-history': 'Social History',
  };
  return map[code] || code;
}

function mapInterpretation(interpretation: string): string {
  const map: Record<string, string> = {
    'normal': 'N', 'abnormal': 'A', 'high': 'H', 'low': 'L',
    'critical_high': 'HH', 'critical_low': 'LL', 'critical': 'AA',
  };
  return map[interpretation.toLowerCase()] || interpretation;
}

function mapEncounterStatus(status: string): string {
  const map: Record<string, string> = {
    'scheduled': 'planned',
    'confirmed': 'planned',
    'checked_in': 'arrived',
    'in_progress': 'in-progress',
    'completed': 'finished',
    'cancelled': 'cancelled',
    'no_show': 'cancelled', // FHIR doesn't have no-show, closest is cancelled
  };
  return map[status] || status;
}

function mapEncounterStatusReverse(status: string): string {
  const map: Record<string, string> = {
    'planned': 'scheduled',
    'arrived': 'checked_in',
    'in-progress': 'in_progress',
    'finished': 'completed',
    'cancelled': 'cancelled',
  };
  return map[status] || status;
}

function mapEncounterClass(type: string): string {
  const map: Record<string, string> = {
    'office': 'AMB',
    'outpatient': 'AMB',
    'inpatient': 'IMP',
    'emergency': 'EMER',
    'home': 'HH',
    'telehealth': 'VR',
    'virtual': 'VR',
  };
  return map[type?.toLowerCase()] || 'AMB';
}
