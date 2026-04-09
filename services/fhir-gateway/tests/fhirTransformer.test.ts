import { transformToFHIR, transformFromFHIR } from '../src/services/fhirTransformer';

// Mock globals
(global as any).__pgPool = {
  query: jest.fn().mockResolvedValue({ rows: [] }),
};
(global as any).__logger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe('fhirTransformer', () => {
  describe('Patient', () => {
    it('should transform internal patient to FHIR Patient', async () => {
      const internalPatient = {
        id: 'patient-uuid-123',
        mrn: 'MRN-001234',
        first_name: 'John',
        middle_name: 'Michael',
        last_name: 'Doe',
        suffix: 'Jr.',
        gender: 'M',
        date_of_birth: '1985-03-15',
        status: 'active',
        phone: '555-123-4567',
        mobile_phone: '555-987-6543',
        email: 'john.doe@email.com',
        address_line_1: '123 Main St',
        address_line_2: 'Apt 4B',
        city: 'Springfield',
        state: 'IL',
        zip_code: '62704',
        country: 'US',
        preferred_language: 'en',
        race: 'White',
        ethnicity: 'Not Hispanic or Latino',
        marital_status: 'married',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-06-15T10:30:00Z',
      };

      const fhir = await transformToFHIR('Patient', internalPatient);

      expect(fhir.resourceType).toBe('Patient');
      expect(fhir.active).toBe(true);
      expect(fhir.gender).toBe('male');
      expect(fhir.birthDate).toBe('1985-03-15');

      // Name
      const officialName = fhir.name.find((n: any) => n.use === 'official');
      expect(officialName).toBeDefined();
      expect(officialName.family).toBe('Doe');
      expect(officialName.given).toContain('John');
      expect(officialName.given).toContain('Michael');
      expect(officialName.suffix).toContain('Jr.');

      // Identifiers
      const mrn = fhir.identifier.find((id: any) =>
        id.type?.coding?.some((c: any) => c.code === 'MR')
      );
      expect(mrn).toBeDefined();
      expect(mrn.value).toBe('MRN-001234');

      // Telecom
      expect(fhir.telecom).toContainEqual(
        expect.objectContaining({ system: 'phone', value: '555-123-4567', use: 'home' })
      );
      expect(fhir.telecom).toContainEqual(
        expect.objectContaining({ system: 'phone', value: '555-987-6543', use: 'mobile' })
      );
      expect(fhir.telecom).toContainEqual(
        expect.objectContaining({ system: 'email', value: 'john.doe@email.com' })
      );

      // Address
      expect(fhir.address).toHaveLength(1);
      expect(fhir.address[0].line).toContain('123 Main St');
      expect(fhir.address[0].city).toBe('Springfield');
      expect(fhir.address[0].state).toBe('IL');

      // US Core extensions
      const raceExt = fhir.extension?.find((e: any) =>
        e.url.includes('us-core-race')
      );
      expect(raceExt).toBeDefined();

      // Language
      expect(fhir.communication).toHaveLength(1);
      expect(fhir.communication[0].language.coding[0].code).toBe('en');
    });

    it('should transform FHIR Patient to internal format', async () => {
      const fhirPatient = {
        resourceType: 'Patient',
        id: 'fhir-123',
        active: true,
        name: [{
          use: 'official',
          family: 'Smith',
          given: ['Jane', 'Marie'],
        }],
        gender: 'female',
        birthDate: '1990-07-22',
        telecom: [
          { system: 'phone', value: '555-000-1111', use: 'home' },
          { system: 'email', value: 'jane@example.com' },
        ],
        address: [{
          use: 'home',
          line: ['456 Oak Ave'],
          city: 'Portland',
          state: 'OR',
          postalCode: '97201',
        }],
        communication: [{
          language: { coding: [{ code: 'es' }] },
          preferred: true,
        }],
      };

      const internal = await transformFromFHIR('Patient', fhirPatient);

      expect(internal.first_name).toBe('Jane');
      expect(internal.middle_name).toBe('Marie');
      expect(internal.last_name).toBe('Smith');
      expect(internal.gender).toBe('F');
      expect(internal.date_of_birth).toBe('1990-07-22');
      expect(internal.status).toBe('active');
      expect(internal.phone).toBe('555-000-1111');
      expect(internal.email).toBe('jane@example.com');
      expect(internal.address_line_1).toBe('456 Oak Ave');
      expect(internal.city).toBe('Portland');
      expect(internal.state).toBe('OR');
      expect(internal.preferred_language).toBe('es');
    });

    it('should handle patient with minimal data', async () => {
      const minimalPatient = {
        id: 'minimal-1',
        first_name: 'Test',
        last_name: 'Patient',
        gender: 'U',
        status: 'active',
      };

      const fhir = await transformToFHIR('Patient', minimalPatient);

      expect(fhir.resourceType).toBe('Patient');
      expect(fhir.gender).toBe('unknown');
      expect(fhir.name).toHaveLength(1);
      expect(fhir.telecom).toHaveLength(0);
      expect(fhir.address).toHaveLength(0);
    });
  });

  describe('Practitioner', () => {
    it('should transform provider to FHIR Practitioner', async () => {
      const provider = {
        id: 'provider-1',
        npi: '1234567890',
        first_name: 'Sarah',
        last_name: 'Johnson',
        name_prefix: 'Dr.',
        gender: 'F',
        status: 'active',
        credentials: ['MD', 'FACC'],
        specialties: [{ specialty_name: 'Cardiovascular Disease' }],
        phone: '555-222-3333',
        email: 'sarah.johnson@hospital.com',
        addresses: [{
          is_primary: true,
          address_line_1: '789 Medical Center Dr',
          city: 'Boston',
          state: 'MA',
          zip_code: '02115',
          country: 'US',
        }],
        updated_at: '2024-06-01T00:00:00Z',
      };

      const fhir = await transformToFHIR('Practitioner', provider);

      expect(fhir.resourceType).toBe('Practitioner');
      expect(fhir.active).toBe(true);
      expect(fhir.gender).toBe('female');

      // NPI identifier
      const npi = fhir.identifier.find((id: any) => id.system === 'http://hl7.org/fhir/sid/us-npi');
      expect(npi).toBeDefined();
      expect(npi.value).toBe('1234567890');

      // Name
      expect(fhir.name[0].family).toBe('Johnson');
      expect(fhir.name[0].given).toContain('Sarah');
      expect(fhir.name[0].prefix).toContain('Dr.');

      // Qualifications
      expect(fhir.qualification).toHaveLength(2);

      // Address
      expect(fhir.address[0].city).toBe('Boston');
    });
  });

  describe('Condition', () => {
    it('should transform condition to FHIR Condition', async () => {
      const condition = {
        id: 'condition-1',
        patient_id: 'patient-1',
        icd10_code: 'E11.9',
        snomed_code: '44054006',
        description: 'Type 2 diabetes mellitus without complications',
        status: 'active',
        onset_date: '2020-03-15',
        created_at: '2020-03-15T10:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const fhir = await transformToFHIR('Condition', condition);

      expect(fhir.resourceType).toBe('Condition');
      expect(fhir.clinicalStatus.coding[0].code).toBe('active');
      expect(fhir.code.coding).toHaveLength(2); // ICD-10 + SNOMED
      expect(fhir.code.coding.find((c: any) => c.system.includes('icd-10')).code).toBe('E11.9');
      expect(fhir.subject.reference).toBe('Patient/patient-1');
      expect(fhir.onsetDateTime).toBe('2020-03-15');
    });
  });

  describe('Observation', () => {
    it('should transform vital sign to FHIR Observation', async () => {
      const observation = {
        id: 'obs-1',
        patient_id: 'patient-1',
        loinc_code: '8867-4',
        name: 'Heart rate',
        category: 'vital-signs',
        value: 72,
        unit: 'bpm',
        unit_code: '/min',
        status: 'final',
        effective_date: '2024-06-15T10:30:00Z',
        reference_low: 60,
        reference_high: 100,
        interpretation: 'normal',
        updated_at: '2024-06-15T10:30:00Z',
      };

      const fhir = await transformToFHIR('Observation', observation);

      expect(fhir.resourceType).toBe('Observation');
      expect(fhir.status).toBe('final');
      expect(fhir.category[0].coding[0].code).toBe('vital-signs');
      expect(fhir.code.coding[0].code).toBe('8867-4');
      expect(fhir.valueQuantity.value).toBe(72);
      expect(fhir.valueQuantity.unit).toBe('bpm');
      expect(fhir.referenceRange[0].low.value).toBe(60);
      expect(fhir.referenceRange[0].high.value).toBe(100);
      expect(fhir.interpretation[0].coding[0].code).toBe('N');
    });

    // TODO: test observation with string value
    // TODO: test observation with coded value
    // TODO: test observation without reference range
  });

  describe('Encounter', () => {
    it('should transform encounter to FHIR Encounter', async () => {
      const encounter = {
        id: 'enc-1',
        patient_id: 'patient-1',
        provider_id: 'provider-1',
        status: 'completed',
        encounter_type: 'office',
        start_time: '2024-06-15T09:00:00Z',
        end_time: '2024-06-15T09:30:00Z',
        reason: 'Annual physical examination',
        facility_name: 'Springfield Medical Center',
        updated_at: '2024-06-15T10:00:00Z',
      };

      const fhir = await transformToFHIR('Encounter', encounter);

      expect(fhir.resourceType).toBe('Encounter');
      expect(fhir.status).toBe('finished');
      expect(fhir.class.code).toBe('AMB');
      expect(fhir.subject.reference).toBe('Patient/patient-1');
      expect(fhir.participant[0].individual.reference).toBe('Practitioner/provider-1');
      expect(fhir.period.start).toBe('2024-06-15T09:00:00Z');
      expect(fhir.period.end).toBe('2024-06-15T09:30:00Z');
    });
  });

  // TODO: test round-trip (internal -> FHIR -> internal)
  // TODO: test error cases (missing required fields)
  // TODO: test with Organization-type practitioner
  // TODO: test MedicationRequest when we implement it
  // TODO: test AllergyIntolerance when we implement it
});
