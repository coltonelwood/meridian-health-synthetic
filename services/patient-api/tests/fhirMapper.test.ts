import { mapToFhirPatient } from '../src/services/fhirMapper';
import { Patient } from '../src/models/Patient';

// Mock TypeORM decorators
jest.mock('typeorm', () => ({
  PrimaryGeneratedColumn: () => () => {},
  Column: () => () => {},
  Entity: () => () => {},
  CreateDateColumn: () => () => {},
  UpdateDateColumn: () => () => {},
  OneToMany: () => () => {},
  ManyToOne: () => () => {},
  JoinColumn: () => () => {},
  Index: () => () => {},
  BeforeInsert: () => () => {},
}));

// Helper to build a Patient object for testing
function buildPatient(overrides: Partial<Patient> = {}): Patient {
  const patient = new Patient();
  Object.assign(patient, {
    id: 'test-patient-uuid-001',
    mrn: 'MRN-12345678',
    firstName: 'Jane',
    middleName: 'Marie',
    lastName: 'Doe',
    prefix: 'Ms.',
    suffix: null,
    dateOfBirth: '1985-03-15',
    dateOfDeath: null,
    isDeceased: false,
    gender: 'female',
    sexAssignedAtBirth: 'female',
    genderIdentity: null,
    sexualOrientation: null,
    race: ['white'],
    ethnicity: 'not-hispanic-or-latino',
    preferredLanguage: 'en',
    maritalStatus: 'married',
    homePhone: '555-123-4567',
    mobilePhone: '555-987-6543',
    workPhone: null,
    email: 'jane.doe@example.com',
    isActive: true,
    status: 'active',
    sourceSystem: 'manual',
    externalId: null,
    addresses: [],
    insuranceCoverages: [],
    createdAt: new Date('2024-01-15T10:30:00Z'),
    updatedAt: new Date('2024-06-20T14:45:00Z'),
    ...overrides,
  });
  return patient;
}

describe('FHIR Patient Mapper', () => {
  describe('mapToFhirPatient', () => {
    it('should map basic patient data to FHIR resource', () => {
      const patient = buildPatient();
      const fhir = mapToFhirPatient(patient);

      expect(fhir.resourceType).toBe('Patient');
      expect(fhir.id).toBe('test-patient-uuid-001');
      expect(fhir.active).toBe(true);
      expect(fhir.birthDate).toBe('1985-03-15');
      expect(fhir.gender).toBe('female');
    });

    it('should include US Core profile in meta', () => {
      const patient = buildPatient();
      const fhir = mapToFhirPatient(patient);

      expect(fhir.meta.profile).toContain(
        'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient'
      );
    });

    it('should map MRN as identifier', () => {
      const patient = buildPatient();
      const fhir = mapToFhirPatient(patient);

      const mrnIdentifier = fhir.identifier.find(
        id => id.type?.coding?.[0]?.code === 'MR'
      );

      expect(mrnIdentifier).toBeDefined();
      expect(mrnIdentifier!.value).toBe('MRN-12345678');
    });

    it('should map patient name correctly', () => {
      const patient = buildPatient();
      const fhir = mapToFhirPatient(patient);

      expect(fhir.name).toHaveLength(1);
      expect(fhir.name[0].use).toBe('official');
      expect(fhir.name[0].family).toBe('Doe');
      expect(fhir.name[0].given).toContain('Jane');
      expect(fhir.name[0].given).toContain('Marie');
      expect(fhir.name[0].prefix).toEqual(['Ms.']);
    });

    it('should map telecom (phone and email)', () => {
      const patient = buildPatient();
      const fhir = mapToFhirPatient(patient);

      const homePhone = fhir.telecom.find(t => t.system === 'phone' && t.use === 'home');
      const mobilePhone = fhir.telecom.find(t => t.system === 'phone' && t.use === 'mobile');
      const email = fhir.telecom.find(t => t.system === 'email');

      expect(homePhone).toBeDefined();
      expect(homePhone!.value).toBe('555-123-4567');
      expect(mobilePhone).toBeDefined();
      expect(mobilePhone!.value).toBe('555-987-6543');
      expect(email).toBeDefined();
      expect(email!.value).toBe('jane.doe@example.com');
    });

    it('should not include work phone when null', () => {
      const patient = buildPatient({ workPhone: undefined });
      const fhir = mapToFhirPatient(patient);

      const workPhone = fhir.telecom.find(t => t.use === 'work');
      expect(workPhone).toBeUndefined();
    });

    describe('gender mapping', () => {
      it('should map "female" to "female"', () => {
        const fhir = mapToFhirPatient(buildPatient({ gender: 'female' }));
        expect(fhir.gender).toBe('female');
      });

      it('should map "male" to "male"', () => {
        const fhir = mapToFhirPatient(buildPatient({ gender: 'male' }));
        expect(fhir.gender).toBe('male');
      });

      it('should map legacy "M" to "male"', () => {
        const fhir = mapToFhirPatient(buildPatient({ gender: 'M' }));
        expect(fhir.gender).toBe('male');
      });

      it('should map legacy "F" to "female"', () => {
        const fhir = mapToFhirPatient(buildPatient({ gender: 'F' }));
        expect(fhir.gender).toBe('female');
      });

      it('should map unknown gender values to "unknown"', () => {
        const fhir = mapToFhirPatient(buildPatient({ gender: 'something-else' }));
        expect(fhir.gender).toBe('unknown');
      });

      // Known issue: non-binary maps to "other" which isn't ideal
      it('should map "non-binary" to "other" (known limitation)', () => {
        const fhir = mapToFhirPatient(buildPatient({ gender: 'non-binary' }));
        expect(fhir.gender).toBe('other');
      });
    });

    describe('deceased handling', () => {
      it('should not include deceased fields for living patient', () => {
        const patient = buildPatient({ isDeceased: false });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.deceasedBoolean).toBeUndefined();
        expect(fhir.deceasedDateTime).toBeUndefined();
      });

      it('should include deceasedDateTime when date of death is known', () => {
        const patient = buildPatient({
          isDeceased: true,
          dateOfDeath: '2024-06-15',
        });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.deceasedDateTime).toBe('2024-06-15');
      });

      it('should include deceasedBoolean when date of death is unknown', () => {
        const patient = buildPatient({
          isDeceased: true,
          dateOfDeath: undefined,
        });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.deceasedBoolean).toBe(true);
      });
    });

    describe('marital status', () => {
      it('should map marital status to FHIR CodeableConcept', () => {
        const patient = buildPatient({ maritalStatus: 'married' });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.maritalStatus).toBeDefined();
        expect(fhir.maritalStatus!.coding[0].code).toBe('M');
        expect(fhir.maritalStatus!.coding[0].system).toContain('MaritalStatus');
      });

      it('should not include marital status when null', () => {
        const patient = buildPatient({ maritalStatus: undefined });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.maritalStatus).toBeUndefined();
      });
    });

    describe('US Core extensions', () => {
      it('should include race extension', () => {
        const patient = buildPatient({ race: ['white', 'asian'] });
        const fhir = mapToFhirPatient(patient);

        const raceExt = fhir.extension?.find(
          e => e.url.includes('us-core-race')
        );
        expect(raceExt).toBeDefined();
        expect(raceExt!.extension).toHaveLength(2);
      });

      it('should include ethnicity extension', () => {
        const patient = buildPatient({ ethnicity: 'hispanic-or-latino' });
        const fhir = mapToFhirPatient(patient);

        const ethExt = fhir.extension?.find(
          e => e.url.includes('us-core-ethnicity')
        );
        expect(ethExt).toBeDefined();
      });

      it('should include birth sex extension when available', () => {
        const patient = buildPatient({ sexAssignedAtBirth: 'female' });
        const fhir = mapToFhirPatient(patient);

        const birthSexExt = fhir.extension?.find(
          e => e.url.includes('us-core-birthsex')
        );
        expect(birthSexExt).toBeDefined();
        expect(birthSexExt!.valueString).toBe('F');
      });

      it('should not include extensions when data is not available', () => {
        const patient = buildPatient({
          race: undefined,
          ethnicity: undefined,
          sexAssignedAtBirth: undefined,
          genderIdentity: undefined,
        });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.extension).toBeUndefined();
      });
    });

    describe('addresses', () => {
      it('should map patient addresses to FHIR format', () => {
        const patient = buildPatient({
          addresses: [
            {
              id: 'addr-1',
              addressType: 'home',
              line1: '123 Main St',
              line2: 'Apt 4B',
              city: 'Springfield',
              state: 'IL',
              zipCode: '62701',
              country: 'US',
              isPrimary: true,
              isGeocoded: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any,
          ],
        });

        const fhir = mapToFhirPatient(patient);

        expect(fhir.address).toHaveLength(1);
        expect(fhir.address[0].use).toBe('home');
        expect(fhir.address[0].line).toEqual(['123 Main St', 'Apt 4B']);
        expect(fhir.address[0].city).toBe('Springfield');
        expect(fhir.address[0].state).toBe('IL');
        expect(fhir.address[0].postalCode).toBe('62701');
      });

      it('should return empty address array when no addresses', () => {
        const patient = buildPatient({ addresses: [] });
        const fhir = mapToFhirPatient(patient);

        expect(fhir.address).toEqual([]);
      });
    });

    // Snapshot test for full mapping
    it('should match snapshot for complete patient', () => {
      const patient = buildPatient({
        addresses: [
          {
            id: 'addr-1',
            addressType: 'home',
            line1: '123 Main St',
            line2: null,
            city: 'Springfield',
            state: 'IL',
            zipCode: '62701',
            country: 'US',
            isPrimary: true,
            isGeocoded: false,
            createdAt: new Date('2024-01-15'),
            updatedAt: new Date('2024-01-15'),
          } as any,
        ],
      });

      const fhir = mapToFhirPatient(patient);

      // Normalize timestamps for snapshot stability
      fhir.meta.lastUpdated = '2024-06-20T14:45:00.000Z';

      expect(fhir).toMatchSnapshot();
    });

    // TODO: test external ID identifier mapping
    // TODO: test with all edge cases (no name, missing fields, etc.)
    // TODO: test mapFromFhirPatient when it's implemented
  });
});
