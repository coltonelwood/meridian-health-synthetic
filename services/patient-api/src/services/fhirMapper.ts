import { Patient } from '../models/Patient';

/**
 * Maps internal Patient model to FHIR R4 Patient resource.
 *
 * FHIR Spec: https://www.hl7.org/fhir/patient.html
 *
 * This mapper is incomplete - we only map the fields we actually need
 * for our current integrations (Epic, state HIE, payer reporting).
 *
 * NOT MAPPED YET:
 *  - communication (language details beyond code)
 *  - contact (emergency contacts in FHIR format)
 *  - link (patient merge/replace links)
 *  - photo
 *  - generalPractitioner (we have the ID but need to resolve to a Practitioner reference)
 *  - managingOrganization
 *
 * Known issues:
 *  - Race/ethnicity uses custom extension URLs that aren't registered
 *  - We don't properly handle the FHIR gender valueset
 *  - Address period mapping is broken
 */

interface FhirPatientResource {
  resourceType: 'Patient';
  id: string;
  meta: {
    versionId?: string;
    lastUpdated: string;
    profile?: string[];
  };
  identifier: FhirIdentifier[];
  active: boolean;
  name: FhirHumanName[];
  telecom: FhirContactPoint[];
  gender?: string;
  birthDate?: string;
  deceasedBoolean?: boolean;
  deceasedDateTime?: string;
  address: FhirAddress[];
  maritalStatus?: FhirCodeableConcept;
  extension?: FhirExtension[];
}

interface FhirIdentifier {
  use?: string;
  type?: FhirCodeableConcept;
  system: string;
  value: string;
}

interface FhirHumanName {
  use?: string;
  family: string;
  given: string[];
  prefix?: string[];
  suffix?: string[];
}

interface FhirContactPoint {
  system: string;
  value: string;
  use?: string;
  rank?: number;
}

interface FhirAddress {
  use?: string;
  type?: string;
  line: string[];
  city: string;
  state: string;
  postalCode: string;
  country: string;
  period?: {
    start?: string;
    end?: string;
  };
}

interface FhirCodeableConcept {
  coding: {
    system: string;
    code: string;
    display?: string;
  }[];
  text?: string;
}

interface FhirExtension {
  url: string;
  valueString?: string;
  valueCoding?: {
    system: string;
    code: string;
    display?: string;
  };
  extension?: FhirExtension[];
}

/**
 * Map internal Patient to FHIR R4 Patient resource
 */
export function mapToFhirPatient(patient: Patient): FhirPatientResource {
  const resource: FhirPatientResource = {
    resourceType: 'Patient',
    id: patient.id,
    meta: {
      lastUpdated: patient.updatedAt?.toISOString() || new Date().toISOString(),
      profile: ['http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'],
    },
    identifier: buildIdentifiers(patient),
    active: patient.isActive,
    name: buildName(patient),
    telecom: buildTelecom(patient),
    gender: mapGender(patient.gender),
    birthDate: patient.dateOfBirth,
    address: buildAddresses(patient),
  };

  // Deceased
  if (patient.isDeceased) {
    if (patient.dateOfDeath) {
      resource.deceasedDateTime = patient.dateOfDeath;
    } else {
      resource.deceasedBoolean = true;
    }
  }

  // Marital status
  if (patient.maritalStatus) {
    resource.maritalStatus = mapMaritalStatus(patient.maritalStatus);
  }

  // Extensions for US Core required fields
  const extensions: FhirExtension[] = [];

  // Race extension (US Core)
  if (patient.race && patient.race.length > 0) {
    extensions.push(buildRaceExtension(patient.race));
  }

  // Ethnicity extension (US Core)
  if (patient.ethnicity) {
    extensions.push(buildEthnicityExtension(patient.ethnicity));
  }

  // Birth sex extension (US Core)
  if (patient.sexAssignedAtBirth) {
    extensions.push({
      url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex',
      valueString: mapBirthSex(patient.sexAssignedAtBirth), // TODO: should be valueCode
    });
  }

  // Gender identity extension
  if (patient.genderIdentity) {
    extensions.push({
      url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-genderIdentity',
      // TODO: this should use the proper coding, not just a string
      valueString: patient.genderIdentity,
    });
  }

  if (extensions.length > 0) {
    resource.extension = extensions;
  }

  return resource;
}

function buildIdentifiers(patient: Patient): FhirIdentifier[] {
  const identifiers: FhirIdentifier[] = [];

  // MRN
  identifiers.push({
    use: 'usual',
    type: {
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
        code: 'MR',
        display: 'Medical Record Number',
      }],
    },
    system: 'urn:oid:2.16.840.1.113883.19.5', // TODO: use our actual OID
    value: patient.mrn,
  });

  // External ID if present
  if (patient.externalId && patient.sourceSystem) {
    identifiers.push({
      use: 'secondary',
      system: `urn:meridian:${patient.sourceSystem}`,
      value: patient.externalId,
    });
  }

  // We intentionally do NOT include SSN as a FHIR identifier
  // even though it technically could be one

  return identifiers;
}

function buildName(patient: Patient): FhirHumanName[] {
  const name: FhirHumanName = {
    use: 'official',
    family: patient.lastName,
    given: [patient.firstName],
  };

  if (patient.middleName) {
    name.given.push(patient.middleName);
  }

  if (patient.prefix) {
    name.prefix = [patient.prefix];
  }

  if (patient.suffix) {
    name.suffix = [patient.suffix];
  }

  return [name];
}

function buildTelecom(patient: Patient): FhirContactPoint[] {
  const telecom: FhirContactPoint[] = [];

  if (patient.homePhone) {
    telecom.push({ system: 'phone', value: patient.homePhone, use: 'home' });
  }

  if (patient.mobilePhone) {
    telecom.push({ system: 'phone', value: patient.mobilePhone, use: 'mobile' });
  }

  if (patient.workPhone) {
    telecom.push({ system: 'phone', value: patient.workPhone, use: 'work' });
  }

  if (patient.email) {
    telecom.push({ system: 'email', value: patient.email, use: 'home' }); // TODO: email use might not be 'home'
  }

  return telecom;
}

function buildAddresses(patient: Patient): FhirAddress[] {
  if (!patient.addresses || patient.addresses.length === 0) {
    return [];
  }

  return patient.addresses.map(addr => {
    const fhirAddr: FhirAddress = {
      use: mapAddressUse(addr.addressType),
      line: [addr.line1, addr.line2].filter(Boolean) as string[],
      city: addr.city,
      state: addr.state,
      postalCode: addr.zipCode,
      country: addr.country || 'US',
    };

    // TODO: period mapping is broken - dates are strings but FHIR wants proper formatting
    // if (addr.startDate || addr.endDate) {
    //   fhirAddr.period = {};
    //   if (addr.startDate) fhirAddr.period.start = addr.startDate;
    //   if (addr.endDate) fhirAddr.period.end = addr.endDate;
    // }

    return fhirAddr;
  });
}

function mapGender(gender: string): string {
  // Our internal values to FHIR valueset
  // http://hl7.org/fhir/administrative-gender
  const genderMap: Record<string, string> = {
    'male': 'male',
    'female': 'female',
    'other': 'other',
    'unknown': 'unknown',
    'M': 'male',     // legacy
    'F': 'female',   // legacy
    'U': 'unknown',  // legacy
    'non-binary': 'other', // TODO: this isn't quite right, FHIR doesn't have non-binary as admin gender
  };
  return genderMap[gender] || 'unknown';
}

function mapBirthSex(sex: string): string {
  const sexMap: Record<string, string> = {
    'male': 'M',
    'female': 'F',
    'unknown': 'UNK',
    'M': 'M',
    'F': 'F',
  };
  return sexMap[sex] || 'UNK';
}

function mapAddressUse(addressType: string): string {
  const useMap: Record<string, string> = {
    'home': 'home',
    'work': 'work',
    'temp': 'temp',
    'billing': 'billing',
    'old': 'old',
  };
  return useMap[addressType] || 'home';
}

function mapMaritalStatus(status: string): FhirCodeableConcept {
  const statusMap: Record<string, { code: string; display: string }> = {
    'single': { code: 'S', display: 'Never Married' },
    'married': { code: 'M', display: 'Married' },
    'divorced': { code: 'D', display: 'Divorced' },
    'widowed': { code: 'W', display: 'Widowed' },
    'separated': { code: 'L', display: 'Legally Separated' },
    'domestic-partner': { code: 'T', display: 'Domestic Partner' }, // not standard but we use it
  };

  const mapped = statusMap[status] || { code: 'UNK', display: 'Unknown' };

  return {
    coding: [{
      system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus',
      code: mapped.code,
      display: mapped.display,
    }],
    text: status,
  };
}

function buildRaceExtension(races: string[]): FhirExtension {
  // US Core Race extension
  // This is complex because it has sub-extensions for OMB category and detailed race
  // We're not doing it 100% correctly here

  const ombRaceMap: Record<string, { code: string; display: string }> = {
    'white': { code: '2106-3', display: 'White' },
    'black': { code: '2054-5', display: 'Black or African American' },
    'asian': { code: '2028-9', display: 'Asian' },
    'native-american': { code: '1002-5', display: 'American Indian or Alaska Native' },
    'pacific-islander': { code: '2076-8', display: 'Native Hawaiian or Other Pacific Islander' },
    'other': { code: '2131-1', display: 'Other Race' },
  };

  const subExtensions: FhirExtension[] = races.map(race => {
    const mapped = ombRaceMap[race];
    if (mapped) {
      return {
        url: 'ombCategory',
        valueCoding: {
          system: 'urn:oid:2.16.840.1.113883.6.238',
          code: mapped.code,
          display: mapped.display,
        },
      };
    }
    // Fallback for unmapped race values
    return {
      url: 'text',
      valueString: race,
    };
  });

  return {
    url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race',
    extension: subExtensions,
  };
}

function buildEthnicityExtension(ethnicity: string): FhirExtension {
  const ethnicityMap: Record<string, { code: string; display: string }> = {
    'hispanic-or-latino': { code: '2135-2', display: 'Hispanic or Latino' },
    'not-hispanic-or-latino': { code: '2186-5', display: 'Not Hispanic or Latino' },
  };

  const mapped = ethnicityMap[ethnicity];

  const extension: FhirExtension = {
    url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity',
    extension: [],
  };

  if (mapped) {
    extension.extension!.push({
      url: 'ombCategory',
      valueCoding: {
        system: 'urn:oid:2.16.840.1.113883.6.238',
        code: mapped.code,
        display: mapped.display,
      },
    });
  }

  extension.extension!.push({
    url: 'text',
    valueString: mapped?.display || ethnicity,
  });

  return extension;
}

// Not exported - was going to map FHIR back to internal model but never finished
// function mapFromFhirPatient(fhirPatient: any): Partial<Patient> {
//   return {
//     firstName: fhirPatient.name?.[0]?.given?.[0],
//     lastName: fhirPatient.name?.[0]?.family,
//     dateOfBirth: fhirPatient.birthDate,
//     gender: fhirPatient.gender,
//     // ... TODO: finish this
//   };
// }
