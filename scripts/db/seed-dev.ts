/**
 * Development Database Seeder - Meridian Health Technologies
 *
 * Seeds the local dev database with realistic-ish test data.
 * Run with: npx tsx scripts/db/seed-dev.ts
 *
 * Author: Sarah Chen (schen@meridianhealth.io)
 * Created: 2023-06-15
 * Modified: 2025-10-22 by mrodriguez - added pharmacy data
 * Modified: 2025-08-03 by schen - updated to match new schema
 *
 * NOTE: This script is NOT idempotent. It will create duplicates if run twice.
 * Use `npm run db:reset` first to wipe the dev database.
 *
 * TODO(schen): Make this idempotent by using upserts
 * TODO(schen): The insurance data generation is pretty bad - it creates
 *   impossible combinations (e.g., Medicare for 25-year-olds). Nobody has
 *   complained because it's just dev data, but it trips up the eligibility
 *   checker sometimes.
 */

import { faker } from '@faker-js/faker';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

// Seed faker for reproducible data
faker.seed(42);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://meridian:meridian@localhost:5432/meridian_dev',
});

// ---- Configuration ---------------------------------------------------------

const NUM_PATIENTS = 500;
const NUM_PROVIDERS = 50;
const NUM_CLAIMS = 2000;
const NUM_APPOINTMENTS = 3000;
const NUM_MEDICATIONS = 800;
const NUM_PHARMACIES = 20;

// ---- Reference Data --------------------------------------------------------

const SPECIALTIES = [
  'Family Medicine', 'Internal Medicine', 'Pediatrics', 'Cardiology',
  'Dermatology', 'Orthopedics', 'Neurology', 'Psychiatry', 'Radiology',
  'Emergency Medicine', 'Obstetrics and Gynecology', 'Ophthalmology',
  'Urology', 'Gastroenterology', 'Pulmonology', 'Endocrinology',
  'Oncology', 'Rheumatology', 'Nephrology', 'Allergy and Immunology',
];

// Common CPT codes we actually use in production
const CPT_CODES = [
  { code: '99213', description: 'Office visit, established patient, low complexity', fee: 95.00 },
  { code: '99214', description: 'Office visit, established patient, moderate complexity', fee: 145.00 },
  { code: '99215', description: 'Office visit, established patient, high complexity', fee: 210.00 },
  { code: '99203', description: 'Office visit, new patient, low complexity', fee: 115.00 },
  { code: '99204', description: 'Office visit, new patient, moderate complexity', fee: 175.00 },
  { code: '99385', description: 'Preventive visit, new, 18-39 years', fee: 195.00 },
  { code: '99386', description: 'Preventive visit, new, 40-64 years', fee: 220.00 },
  { code: '99395', description: 'Preventive visit, established, 18-39 years', fee: 175.00 },
  { code: '99396', description: 'Preventive visit, established, 40-64 years', fee: 195.00 },
  { code: '36415', description: 'Blood draw (venipuncture)', fee: 12.00 },
  { code: '85025', description: 'CBC with differential', fee: 18.00 },
  { code: '80053', description: 'Comprehensive metabolic panel', fee: 22.00 },
  { code: '81001', description: 'Urinalysis', fee: 8.00 },
  { code: '71046', description: 'Chest X-ray, 2 views', fee: 85.00 },
  { code: '93000', description: 'Electrocardiogram (ECG)', fee: 55.00 },
  { code: '90715', description: 'Tdap vaccine', fee: 45.00 },
  { code: '90471', description: 'Immunization administration', fee: 25.00 },
  { code: '10060', description: 'Incision and drainage, abscess', fee: 180.00 },
  { code: '17000', description: 'Destruction of skin lesion', fee: 95.00 },
  { code: '99291', description: 'Critical care, first 30-74 min', fee: 450.00 },
];

// ICD-10 codes for common diagnoses
const ICD10_CODES = [
  { code: 'J06.9', description: 'Acute upper respiratory infection' },
  { code: 'J02.9', description: 'Acute pharyngitis' },
  { code: 'I10', description: 'Essential hypertension' },
  { code: 'E11.9', description: 'Type 2 diabetes mellitus' },
  { code: 'E78.5', description: 'Dyslipidemia' },
  { code: 'M54.5', description: 'Low back pain' },
  { code: 'J45.20', description: 'Mild intermittent asthma' },
  { code: 'F32.1', description: 'Major depressive disorder, moderate' },
  { code: 'F41.1', description: 'Generalized anxiety disorder' },
  { code: 'K21.0', description: 'GERD with esophagitis' },
  { code: 'N39.0', description: 'Urinary tract infection' },
  { code: 'J20.9', description: 'Acute bronchitis' },
  { code: 'R10.9', description: 'Unspecified abdominal pain' },
  { code: 'R51', description: 'Headache' },
  { code: 'L30.9', description: 'Dermatitis, unspecified' },
  { code: 'M79.3', description: 'Panniculitis' },
  { code: 'Z00.00', description: 'General adult medical examination' },
  { code: 'Z23', description: 'Encounter for immunization' },
];

const PAYERS = [
  { name: 'Blue Cross Blue Shield', payerId: 'BCBS001', planTypes: ['PPO', 'HMO', 'EPO'] },
  { name: 'Aetna', payerId: 'AETNA01', planTypes: ['PPO', 'HMO'] },
  { name: 'UnitedHealthcare', payerId: 'UHC0001', planTypes: ['PPO', 'HMO', 'POS'] },
  { name: 'Cigna', payerId: 'CIGNA01', planTypes: ['PPO', 'HMO'] },
  { name: 'Humana', payerId: 'HUMANA1', planTypes: ['PPO', 'HMO', 'Medicare Advantage'] },
  { name: 'Medicare', payerId: 'MEDCR01', planTypes: ['Part A', 'Part B', 'Part A+B'] },
  { name: 'Medicaid', payerId: 'MEDCD01', planTypes: ['Managed Care', 'Fee-for-Service'] },
  { name: 'Kaiser Permanente', payerId: 'KAISER1', planTypes: ['HMO'] },
  { name: 'Self-Pay', payerId: 'SELF001', planTypes: ['Self-Pay'] },
];

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
];

// Drug names for pharmacy data (mrodriguez)
const COMMON_DRUGS = [
  { name: 'Lisinopril', ndc: '00378-0517-01', strength: '10mg', form: 'tablet' },
  { name: 'Metformin', ndc: '00093-7214-01', strength: '500mg', form: 'tablet' },
  { name: 'Atorvastatin', ndc: '00378-3952-77', strength: '20mg', form: 'tablet' },
  { name: 'Amlodipine', ndc: '00093-3171-56', strength: '5mg', form: 'tablet' },
  { name: 'Metoprolol', ndc: '00378-0181-01', strength: '25mg', form: 'tablet' },
  { name: 'Omeprazole', ndc: '62175-0256-37', strength: '20mg', form: 'capsule' },
  { name: 'Albuterol', ndc: '66993-0019-68', strength: '90mcg', form: 'inhaler' },
  { name: 'Sertraline', ndc: '00093-7198-56', strength: '50mg', form: 'tablet' },
  { name: 'Amoxicillin', ndc: '65862-0015-05', strength: '500mg', form: 'capsule' },
  { name: 'Gabapentin', ndc: '00228-2636-11', strength: '300mg', form: 'capsule' },
  { name: 'Prednisone', ndc: '00054-4741-25', strength: '10mg', form: 'tablet' },
  { name: 'Ibuprofen', ndc: '00904-7915-60', strength: '200mg', form: 'tablet' },
  { name: 'Levothyroxine', ndc: '00378-1805-01', strength: '50mcg', form: 'tablet' },
  { name: 'Hydrochlorothiazide', ndc: '00378-0192-01', strength: '25mg', form: 'tablet' },
  { name: 'Fluticasone', ndc: '00054-0547-13', strength: '50mcg', form: 'spray' },
];

// ---- Helper Functions ------------------------------------------------------

function generateMRN(): string {
  // MRN format: MRN-XXXXXXXX (8 digits)
  // NOTE: In production, MRNs come from the master patient index (MPI) via
  // the registration service. These are just random for dev.
  return `MRN-${faker.string.numeric(8)}`;
}

function generateNPI(): string {
  // NPI is a 10-digit number starting with 1 or 2
  return `${faker.helpers.arrayElement(['1', '2'])}${faker.string.numeric(9)}`;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDateBetween(start: Date, end: Date): Date {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

// ---- Generators ------------------------------------------------------------

interface Patient {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  gender: string;
  ssn: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zipCode: string;
  insurancePayer: string;
  insurancePayerId: string;
  insurancePlanType: string;
  insuranceMemberId: string;
  insuranceGroupNumber: string;
  primaryProviderId: string | null;
  isActive: boolean;
}

function generatePatients(count: number): Patient[] {
  const patients: Patient[] = [];

  for (let i = 0; i < count; i++) {
    const gender = faker.helpers.arrayElement(['M', 'F']);
    const firstName = gender === 'M' ? faker.person.firstName('male') : faker.person.firstName('female');
    const lastName = faker.person.lastName();

    // BUG: This doesn't account for age-appropriate insurance
    // A 25 year old shouldn't have Medicare, but we generate that sometimes
    // mrodriguez pointed this out in code review but we never fixed it
    const payer = pickRandom(PAYERS);
    const planType = pickRandom(payer.planTypes);

    const dob = faker.date.birthdate({ min: 0, max: 95, mode: 'age' });

    patients.push({
      id: randomUUID(),
      mrn: generateMRN(),
      firstName,
      lastName,
      dateOfBirth: dob,
      gender,
      ssn: faker.string.numeric(3) + '-' + faker.string.numeric(2) + '-' + faker.string.numeric(4),
      email: faker.internet.email({ firstName, lastName }).toLowerCase(),
      phone: faker.phone.number({ style: 'national' }),
      addressLine1: faker.location.streetAddress(),
      addressLine2: Math.random() > 0.7 ? faker.location.secondaryAddress() : null,
      city: faker.location.city(),
      state: pickRandom(US_STATES),
      zipCode: faker.location.zipCode('#####'),
      insurancePayer: payer.name,
      insurancePayerId: payer.payerId,
      insurancePlanType: planType,
      insuranceMemberId: faker.string.alphanumeric(12).toUpperCase(),
      insuranceGroupNumber: faker.string.alphanumeric(8).toUpperCase(),
      primaryProviderId: null,  // will be assigned after providers are created
      isActive: Math.random() > 0.05,  // 5% inactive
    });
  }

  return patients;
}

interface Provider {
  id: string;
  npi: string;
  firstName: string;
  lastName: string;
  specialty: string;
  email: string;
  phone: string;
  licenseNumber: string;
  licenseState: string;
  deaNumber: string | null;
  isAcceptingPatients: boolean;
  maxPanelSize: number;
}

function generateProviders(count: number): Provider[] {
  const providers: Provider[] = [];

  for (let i = 0; i < count; i++) {
    const specialty = pickRandom(SPECIALTIES);
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const state = pickRandom(US_STATES);

    providers.push({
      id: randomUUID(),
      npi: generateNPI(),
      firstName,
      lastName,
      specialty,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@meridianhealth.io`,
      phone: faker.phone.number({ style: 'national' }),
      licenseNumber: `${state}-${faker.string.numeric(8)}`,
      licenseState: state,
      // Only providers who prescribe need DEA numbers
      deaNumber: ['Radiology', 'Ophthalmology'].includes(specialty)
        ? null
        : `F${faker.string.alphanumeric(8).toUpperCase()}`,
      isAcceptingPatients: Math.random() > 0.2,
      maxPanelSize: faker.helpers.arrayElement([500, 750, 1000, 1500, 2000]),
    });
  }

  return providers;
}

interface Claim {
  id: string;
  claimNumber: string;
  patientId: string;
  providerId: string;
  dateOfService: Date;
  dateFiled: Date;
  status: string;
  totalCharged: number;
  totalAllowed: number;
  totalPaid: number;
  patientResponsibility: number;
  cptCode: string;
  cptDescription: string;
  icd10Code: string;
  icd10Description: string;
  payerId: string;
  payerName: string;
  placeOfService: string;
}

function generateClaims(
  count: number,
  patientIds: string[],
  providerIds: string[]
): Claim[] {
  const claims: Claim[] = [];
  const statuses = ['submitted', 'pending', 'approved', 'denied', 'paid', 'appealed', 'void'];
  const statusWeights = [0.05, 0.10, 0.15, 0.05, 0.55, 0.05, 0.05];

  // lol this is a janky way to do weighted random but whatever it works
  function weightedStatus(): string {
    const r = Math.random();
    let sum = 0;
    for (let i = 0; i < statuses.length; i++) {
      sum += statusWeights[i];
      if (r < sum) return statuses[i];
    }
    return 'submitted';
  }

  for (let i = 0; i < count; i++) {
    const cpt = pickRandom(CPT_CODES);
    const icd10 = pickRandom(ICD10_CODES);
    const payer = pickRandom(PAYERS);
    const status = weightedStatus();

    const dateOfService = randomDateBetween(new Date('2024-01-01'), new Date('2025-12-31'));
    const dateFiled = new Date(dateOfService.getTime() + Math.random() * 7 * 24 * 60 * 60 * 1000); // 0-7 days after service

    const totalCharged = cpt.fee;
    // Allowed amount is usually less than charged
    const totalAllowed = Math.round(totalCharged * (0.6 + Math.random() * 0.3) * 100) / 100;

    let totalPaid = 0;
    let patientResponsibility = 0;

    if (status === 'paid' || status === 'approved') {
      // Payer covers 70-90% of allowed
      totalPaid = Math.round(totalAllowed * (0.7 + Math.random() * 0.2) * 100) / 100;
      patientResponsibility = Math.round((totalAllowed - totalPaid) * 100) / 100;
    } else if (status === 'denied') {
      totalPaid = 0;
      patientResponsibility = totalCharged;  // patient responsible for full charge if denied
    }
    // other statuses: pending amounts, zero for now

    claims.push({
      id: randomUUID(),
      claimNumber: `CLM-${dateOfService.getFullYear()}${String(dateOfService.getMonth() + 1).padStart(2, '0')}-${faker.string.numeric(6)}`,
      patientId: pickRandom(patientIds),
      providerId: pickRandom(providerIds),
      dateOfService,
      dateFiled,
      status,
      totalCharged,
      totalAllowed,
      totalPaid,
      patientResponsibility,
      cptCode: cpt.code,
      cptDescription: cpt.description,
      icd10Code: icd10.code,
      icd10Description: icd10.description,
      payerId: payer.payerId,
      payerName: payer.name,
      placeOfService: faker.helpers.arrayElement(['11', '22', '23', '81']),  // office, outpatient, ER, independent lab
    });
  }

  return claims;
}

// ---- Database Insertion ----------------------------------------------------

async function insertPatients(patients: Patient[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of patients) {
      await client.query(
        `INSERT INTO patients (
          id, mrn, first_name, last_name, date_of_birth, gender, ssn_encrypted,
          email, phone, address_line1, address_line2, city, state, zip_code,
          insurance_payer, insurance_payer_id, insurance_plan_type,
          insurance_member_id, insurance_group_number,
          primary_provider_id, is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW(),NOW())`,
        [
          p.id, p.mrn, p.firstName, p.lastName, p.dateOfBirth, p.gender,
          p.ssn,  // TODO: This should be encrypted! We're storing plaintext SSNs in dev. Fine for fake data but scary pattern.
          p.email, p.phone, p.addressLine1, p.addressLine2, p.city, p.state, p.zipCode,
          p.insurancePayer, p.insurancePayerId, p.insurancePlanType,
          p.insuranceMemberId, p.insuranceGroupNumber,
          p.primaryProviderId, p.isActive,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertProviders(providers: Provider[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of providers) {
      await client.query(
        `INSERT INTO providers (
          id, npi, first_name, last_name, specialty, email, phone,
          license_number, license_state, dea_number,
          is_accepting_patients, max_panel_size, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())`,
        [
          p.id, p.npi, p.firstName, p.lastName, p.specialty, p.email, p.phone,
          p.licenseNumber, p.licenseState, p.deaNumber,
          p.isAcceptingPatients, p.maxPanelSize,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertClaims(claims: Claim[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Doing one at a time is slow but it's a seed script, who cares
    // (famous last words - this takes 45 seconds for 2000 claims)
    for (const c of claims) {
      await client.query(
        `INSERT INTO claims (
          id, claim_number, patient_id, provider_id, date_of_service, date_filed,
          status, total_charged, total_allowed, total_paid, patient_responsibility,
          cpt_code, cpt_description, icd10_code, icd10_description,
          payer_id, payer_name, place_of_service, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())`,
        [
          c.id, c.claimNumber, c.patientId, c.providerId, c.dateOfService, c.dateFiled,
          c.status, c.totalCharged, c.totalAllowed, c.totalPaid, c.patientResponsibility,
          c.cptCode, c.cptDescription, c.icd10Code, c.icd10Description,
          c.payerId, c.payerName, c.placeOfService,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertAppointments(
  count: number,
  patientIds: string[],
  providerIds: string[]
): Promise<void> {
  const client = await pool.connect();
  const appointmentTypes = ['office-visit', 'telehealth', 'follow-up', 'annual-physical', 'urgent', 'procedure'];
  const statuses = ['scheduled', 'confirmed', 'checked-in', 'in-progress', 'completed', 'no-show', 'cancelled'];

  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i++) {
      const appointmentDate = randomDateBetween(new Date('2024-06-01'), new Date('2026-06-30'));
      const durationMinutes = faker.helpers.arrayElement([15, 20, 30, 45, 60]);
      const appointmentType = pickRandom(appointmentTypes);
      const isPast = appointmentDate < new Date();

      let status: string;
      if (isPast) {
        // past appointments should be completed or no-show, mostly
        status = faker.helpers.weightedArrayElement([
          { value: 'completed', weight: 75 },
          { value: 'no-show', weight: 10 },
          { value: 'cancelled', weight: 15 },
        ]);
      } else {
        status = faker.helpers.weightedArrayElement([
          { value: 'scheduled', weight: 50 },
          { value: 'confirmed', weight: 40 },
          { value: 'cancelled', weight: 10 },
        ]);
      }

      await client.query(
        `INSERT INTO appointments (
          id, patient_id, provider_id, appointment_date, duration_minutes,
          appointment_type, status, reason, notes, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
        [
          randomUUID(),
          pickRandom(patientIds),
          pickRandom(providerIds),
          appointmentDate,
          durationMinutes,
          appointmentType,
          status,
          pickRandom(ICD10_CODES).description,  // using diagnosis as reason, close enough
          isPast && status === 'completed' ? faker.lorem.sentence() : null,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertPharmacies(count: number): Promise<string[]> {
  // Added by mrodriguez 2025-10-22
  const client = await pool.connect();
  const pharmacyIds: string[] = [];
  const chains = ['CVS', 'Walgreens', 'Rite Aid', 'Costco Pharmacy', 'Walmart Pharmacy', 'Kroger Pharmacy'];

  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      pharmacyIds.push(id);
      const isChain = Math.random() > 0.3;
      const name = isChain
        ? `${pickRandom(chains)} #${faker.string.numeric(4)}`
        : `${faker.person.lastName()} Pharmacy`;

      await client.query(
        `INSERT INTO pharmacies (
          id, name, ncpdp_id, npi, phone, fax,
          address_line1, city, state, zip_code,
          is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
        [
          id, name,
          faker.string.numeric(7),  // NCPDP ID
          generateNPI(),
          faker.phone.number({ style: 'national' }),
          faker.phone.number({ style: 'national' }),
          faker.location.streetAddress(),
          faker.location.city(),
          pickRandom(US_STATES),
          faker.location.zipCode('#####'),
          Math.random() > 0.1,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return pharmacyIds;
}

async function insertMedications(
  count: number,
  patientIds: string[],
  providerIds: string[],
  pharmacyIds: string[]
): Promise<void> {
  // Added by mrodriguez 2025-10-22
  const client = await pool.connect();
  const statuses = ['active', 'discontinued', 'completed', 'on-hold'];

  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i++) {
      const drug = pickRandom(COMMON_DRUGS);
      const startDate = randomDateBetween(new Date('2024-01-01'), new Date('2025-12-31'));
      const status = pickRandom(statuses);
      const endDate = status === 'active' ? null : new Date(startDate.getTime() + Math.random() * 180 * 24 * 60 * 60 * 1000);

      await client.query(
        `INSERT INTO medications (
          id, patient_id, prescribing_provider_id, pharmacy_id,
          drug_name, ndc, strength, form, sig,
          quantity, days_supply, refills_remaining,
          start_date, end_date, status,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())`,
        [
          randomUUID(),
          pickRandom(patientIds),
          pickRandom(providerIds),
          Math.random() > 0.1 ? pickRandom(pharmacyIds) : null,  // some don't have pharmacy yet
          drug.name, drug.ndc, drug.strength, drug.form,
          faker.helpers.arrayElement([
            'Take 1 tablet by mouth daily',
            'Take 1 tablet by mouth twice daily',
            'Take 2 tablets by mouth at bedtime',
            'Inhale 2 puffs every 4-6 hours as needed',
            'Apply topically twice daily',
            'Take 1 capsule by mouth three times daily with food',
          ]),
          faker.helpers.arrayElement([30, 60, 90]),
          faker.helpers.arrayElement([30, 60, 90]),
          faker.helpers.arrayElement([0, 1, 2, 3, 5, 11]),
          startDate,
          endDate,
          status,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Meridian Health - Dev Database Seeder ===');
  console.log(`Database: ${process.env.DATABASE_URL || 'postgresql://localhost:5432/meridian_dev'}`);
  console.log('');

  try {
    // Test connection
    await pool.query('SELECT 1');
    console.log('Connected to database.');

    // Generate data
    console.log(`\nGenerating ${NUM_PROVIDERS} providers...`);
    const providers = generateProviders(NUM_PROVIDERS);

    console.log(`Generating ${NUM_PATIENTS} patients...`);
    const patients = generatePatients(NUM_PATIENTS);

    // Assign primary providers to patients
    const providerIds = providers.map(p => p.id);
    for (const patient of patients) {
      if (Math.random() > 0.15) {  // 85% have a PCP assigned
        patient.primaryProviderId = pickRandom(providerIds);
      }
    }

    const patientIds = patients.map(p => p.id);

    console.log(`Generating ${NUM_CLAIMS} claims...`);
    const claims = generateClaims(NUM_CLAIMS, patientIds, providerIds);

    // Insert in order due to foreign keys
    console.log('\nInserting providers...');
    await insertProviders(providers);
    console.log(`  Inserted ${providers.length} providers`);

    console.log('Inserting patients...');
    await insertPatients(patients);
    console.log(`  Inserted ${patients.length} patients`);

    console.log('Inserting claims...');
    await insertClaims(claims);
    console.log(`  Inserted ${claims.length} claims`);

    console.log(`Inserting ${NUM_APPOINTMENTS} appointments...`);
    await insertAppointments(NUM_APPOINTMENTS, patientIds, providerIds);
    console.log(`  Inserted ${NUM_APPOINTMENTS} appointments`);

    console.log(`\nInserting ${NUM_PHARMACIES} pharmacies...`);
    const pharmacyIds = await insertPharmacies(NUM_PHARMACIES);
    console.log(`  Inserted ${pharmacyIds.length} pharmacies`);

    console.log(`Inserting ${NUM_MEDICATIONS} medications...`);
    await insertMedications(NUM_MEDICATIONS, patientIds, providerIds, pharmacyIds);
    console.log(`  Inserted ${NUM_MEDICATIONS} medications`);

    // Print summary
    console.log('\n=== Seed Complete ===');
    console.log(`  Providers:    ${NUM_PROVIDERS}`);
    console.log(`  Patients:     ${NUM_PATIENTS}`);
    console.log(`  Claims:       ${NUM_CLAIMS}`);
    console.log(`  Appointments: ${NUM_APPOINTMENTS}`);
    console.log(`  Pharmacies:   ${NUM_PHARMACIES}`);
    console.log(`  Medications:  ${NUM_MEDICATIONS}`);
    console.log('');
    console.log('Test credentials:');
    console.log('  Admin: admin@meridianhealth.io / password123');
    console.log('  Provider: dr.smith@meridianhealth.io / password123');
    console.log('  Front Desk: frontdesk@meridianhealth.io / password123');

  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
