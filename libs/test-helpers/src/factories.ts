/**
 * Test data factories using @faker-js/faker.
 *
 * These factories create realistic test data that mimics production data
 * patterns. Use them in unit and integration tests to avoid hardcoding
 * test data.
 *
 * All factories accept optional overrides so you can customize specific
 * fields while getting sensible defaults for everything else.
 *
 * IMPORTANT: These factories generate fake PHI for testing only.
 * Never use real patient data in tests. If you need to test with
 * production-like data volumes, use the data-generator tool which
 * creates anonymized datasets.
 */

import { faker } from '@faker-js/faker';
import { generateMRN, generateClaimNumber, generateReferralId } from '@meridian/shared-utils';

// Seed faker for reproducible tests (can be overridden)
faker.seed(12345);

// --- Patient Factory ---------------------------------------------------------

export interface TestPatient {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: 'male' | 'female' | 'other';
  ssn: string;
  email: string;
  phone: string;
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  };
  insurance: TestInsurance;
  preferredLanguage: string;
  communicationPreference: 'email' | 'phone' | 'portal';
  status: 'active' | 'inactive';
  createdAt: string;
}

export function createPatient(overrides: Partial<TestPatient> = {}): TestPatient {
  const gender = faker.helpers.arrayElement(['male', 'female', 'other'] as const);

  return {
    id: faker.string.uuid(),
    mrn: generateMRN(),
    firstName: faker.person.firstName(gender === 'other' ? undefined : gender),
    lastName: faker.person.lastName(),
    dateOfBirth: faker.date.birthdate({ min: 1, max: 100, mode: 'age' }).toISOString().split('T')[0],
    gender,
    ssn: `${faker.string.numeric(3)}-${faker.string.numeric(2)}-${faker.string.numeric(4)}`,
    email: faker.internet.email(),
    phone: faker.phone.number('###-###-####'),
    address: {
      street: faker.location.streetAddress(),
      city: faker.location.city(),
      state: faker.location.state({ abbreviated: true }),
      zip: faker.location.zipCode(),
    },
    insurance: createInsurance(),
    preferredLanguage: faker.helpers.arrayElement(['en', 'es', 'zh', 'vi', 'ko', 'fr']),
    communicationPreference: faker.helpers.arrayElement(['email', 'phone', 'portal']),
    status: 'active',
    createdAt: faker.date.recent({ days: 365 }).toISOString(),
    ...overrides,
  };
}

// --- Insurance Factory -------------------------------------------------------

export interface TestInsurance {
  payerId: string;
  payerName: string;
  memberId: string;
  groupNumber: string;
  planType: 'HMO' | 'PPO' | 'EPO' | 'POS' | 'Medicare' | 'Medicaid';
  effectiveDate: string;
  terminationDate: string | null;
  copay: number;         // cents
  deductible: number;    // cents
  outOfPocketMax: number; // cents
}

export function createInsurance(overrides: Partial<TestInsurance> = {}): TestInsurance {
  const payers = [
    { id: 'BCBS-001', name: 'Blue Cross Blue Shield' },
    { id: 'UHC-001', name: 'UnitedHealthcare' },
    { id: 'AETNA-001', name: 'Aetna' },
    { id: 'CIGNA-001', name: 'Cigna' },
    { id: 'HUMANA-001', name: 'Humana' },
    { id: 'CMS-MEDICARE', name: 'Medicare' },
    { id: 'CMS-MEDICAID', name: 'Medicaid' },
  ];

  const payer = faker.helpers.arrayElement(payers);

  return {
    payerId: payer.id,
    payerName: payer.name,
    memberId: faker.string.alphanumeric(12).toUpperCase(),
    groupNumber: faker.string.alphanumeric(8).toUpperCase(),
    planType: faker.helpers.arrayElement(['HMO', 'PPO', 'EPO', 'POS', 'Medicare', 'Medicaid']),
    effectiveDate: faker.date.past({ years: 2 }).toISOString().split('T')[0],
    terminationDate: null,
    copay: faker.helpers.arrayElement([2000, 2500, 3000, 3500, 4000, 5000]), // $20-$50
    deductible: faker.helpers.arrayElement([50000, 100000, 150000, 250000, 500000]),
    outOfPocketMax: faker.helpers.arrayElement([500000, 750000, 1000000, 1500000]),
    ...overrides,
  };
}

// --- Claim Factory -----------------------------------------------------------

export interface TestClaim {
  id: string;
  claimNumber: string;
  patientId: string;
  providerId: string;
  facilityId: string;
  claimType: '837P' | '837I';
  serviceLines: TestServiceLine[];
  diagnosisCodes: TestDiagnosis[];
  totalCharge: number;  // cents
  payerId: string;
  subscriberId: string;
  status: string;
  submittedAt: string | null;
  trackingNumber: string | null;
}

export function createClaim(overrides: Partial<TestClaim> = {}): TestClaim {
  const serviceLines = overrides.serviceLines || [
    createServiceLine({ lineNumber: 1 }),
    createServiceLine({ lineNumber: 2 }),
  ];
  const totalCharge = serviceLines.reduce(
    (sum, line) => sum + line.chargeAmount * line.units, 0
  );

  return {
    id: faker.string.uuid(),
    claimNumber: generateClaimNumber('MHC01'),
    patientId: faker.string.uuid(),
    providerId: faker.string.uuid(),
    facilityId: 'MHC01',
    claimType: faker.helpers.arrayElement(['837P', '837I']),
    serviceLines,
    diagnosisCodes: overrides.diagnosisCodes || [
      createDiagnosis({ sequence: 1 }),
      createDiagnosis({ sequence: 2 }),
    ],
    totalCharge,
    payerId: faker.helpers.arrayElement(['BCBS-001', 'UHC-001', 'AETNA-001']),
    subscriberId: faker.string.alphanumeric(12).toUpperCase(),
    status: 'pending',
    submittedAt: null,
    trackingNumber: null,
    ...overrides,
  };
}

// --- Service Line Factory ----------------------------------------------------

export interface TestServiceLine {
  lineNumber: number;
  procedureCode: string;
  modifiers: string[];
  diagnosisPointers: number[];
  chargeAmount: number; // cents
  units: number;
  serviceDate: string;
  placeOfService: string;
}

export function createServiceLine(overrides: Partial<TestServiceLine> = {}): TestServiceLine {
  const cptCodes = ['99213', '99214', '99215', '99203', '99204', '99243', '36415', '80053', '85025'];

  return {
    lineNumber: 1,
    procedureCode: faker.helpers.arrayElement(cptCodes),
    modifiers: [],
    diagnosisPointers: [1],
    chargeAmount: faker.number.int({ min: 5000, max: 50000 }),
    units: 1,
    serviceDate: faker.date.recent({ days: 30 }).toISOString().split('T')[0],
    placeOfService: faker.helpers.arrayElement(['11', '21', '22', '02']),
    ...overrides,
  };
}

// --- Diagnosis Factory -------------------------------------------------------

export interface TestDiagnosis {
  code: string;
  type: 'ICD10';
  sequence: number;
  description: string;
}

export function createDiagnosis(overrides: Partial<TestDiagnosis> = {}): TestDiagnosis {
  const diagnoses = [
    { code: 'J06.9', description: 'Acute upper respiratory infection, unspecified' },
    { code: 'I10', description: 'Essential (primary) hypertension' },
    { code: 'E11.9', description: 'Type 2 diabetes mellitus without complications' },
    { code: 'M54.5', description: 'Low back pain' },
    { code: 'J18.9', description: 'Pneumonia, unspecified organism' },
    { code: 'I50.9', description: 'Heart failure, unspecified' },
    { code: 'R05.9', description: 'Cough, unspecified' },
    { code: 'Z00.00', description: 'General adult medical examination' },
    { code: 'K21.0', description: 'Gastro-esophageal reflux disease with esophagitis' },
    { code: 'F41.1', description: 'Generalized anxiety disorder' },
  ];

  const dx = faker.helpers.arrayElement(diagnoses);

  return {
    code: dx.code,
    type: 'ICD10',
    sequence: 1,
    description: dx.description,
    ...overrides,
  };
}

// --- Provider Factory --------------------------------------------------------

export interface TestProvider {
  id: string;
  npi: string;
  firstName: string;
  lastName: string;
  specialtyCode: string;
  specialtyDescription: string;
  email: string;
  phone: string;
  facilityId: string;
  credentialingStatus: 'active' | 'pending' | 'expired';
  acceptingNewPatients: boolean;
}

export function createProvider(overrides: Partial<TestProvider> = {}): TestProvider {
  const specialties = [
    { code: '207R00000X', description: 'Internal Medicine' },
    { code: '207Q00000X', description: 'Family Medicine' },
    { code: '207RC0000X', description: 'Cardiovascular Disease' },
    { code: '2084P0800X', description: 'Psychiatry' },
    { code: '207RG0300X', description: 'Geriatric Medicine' },
  ];

  const specialty = faker.helpers.arrayElement(specialties);

  return {
    id: faker.string.uuid(),
    npi: `1${faker.string.numeric(9)}`, // Starts with 1 for individual
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    specialtyCode: specialty.code,
    specialtyDescription: specialty.description,
    email: faker.internet.email(),
    phone: faker.phone.number('###-###-####'),
    facilityId: 'MHC01',
    credentialingStatus: 'active',
    acceptingNewPatients: faker.datatype.boolean(0.8), // 80% accepting
    ...overrides,
  };
}

// --- Appointment Factory -----------------------------------------------------

export interface TestAppointment {
  id: string;
  patientId: string;
  providerId: string;
  dateTime: string;
  duration: number;
  type: string;
  status: 'scheduled' | 'checked_in' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  notes?: string;
}

export function createAppointment(overrides: Partial<TestAppointment> = {}): TestAppointment {
  return {
    id: faker.string.uuid(),
    patientId: faker.string.uuid(),
    providerId: faker.string.uuid(),
    dateTime: faker.date.soon({ days: 30 }).toISOString(),
    duration: faker.helpers.arrayElement([15, 30, 45, 60]),
    type: faker.helpers.arrayElement(['office_visit', 'follow_up', 'new_patient', 'telehealth', 'procedure']),
    status: 'scheduled',
    ...overrides,
  };
}

// --- Referral Factory --------------------------------------------------------

export interface TestReferral {
  id: string;
  patientId: string;
  referringProviderId: string;
  referredToProviderId: string;
  specialtyCode: string;
  urgency: 'routine' | 'urgent' | 'emergent';
  status: 'active' | 'completed' | 'expired' | 'canceled';
  numberOfVisits: number;
  visitsCompleted: number;
}

export function createReferral(overrides: Partial<TestReferral> = {}): TestReferral {
  const numberOfVisits = faker.number.int({ min: 1, max: 12 });

  return {
    id: generateReferralId(),
    patientId: faker.string.uuid(),
    referringProviderId: faker.string.uuid(),
    referredToProviderId: faker.string.uuid(),
    specialtyCode: '207RC0000X',
    urgency: faker.helpers.arrayElement(['routine', 'urgent', 'emergent']),
    status: 'active',
    numberOfVisits,
    visitsCompleted: faker.number.int({ min: 0, max: numberOfVisits }),
    ...overrides,
  };
}

// --- Medication Factory ------------------------------------------------------

export interface TestMedication {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  route: string;
  prescribedBy: string;
  startDate: string;
  status: 'active' | 'discontinued';
}

export function createMedication(overrides: Partial<TestMedication> = {}): TestMedication {
  const medications = [
    { name: 'Lisinopril', dosage: '10mg', route: 'oral' },
    { name: 'Metformin', dosage: '500mg', route: 'oral' },
    { name: 'Atorvastatin', dosage: '20mg', route: 'oral' },
    { name: 'Amlodipine', dosage: '5mg', route: 'oral' },
    { name: 'Omeprazole', dosage: '20mg', route: 'oral' },
    { name: 'Albuterol', dosage: '90mcg', route: 'inhalation' },
  ];

  const med = faker.helpers.arrayElement(medications);

  return {
    id: faker.string.uuid(),
    name: med.name,
    dosage: med.dosage,
    frequency: faker.helpers.arrayElement(['once daily', 'twice daily', 'three times daily', 'as needed']),
    route: med.route,
    prescribedBy: faker.string.uuid(),
    startDate: faker.date.recent({ days: 180 }).toISOString().split('T')[0],
    status: 'active',
    ...overrides,
  };
}
