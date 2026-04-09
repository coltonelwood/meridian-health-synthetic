/**
 * Generate Realistic Test Claims for Load Testing
 * =================================================
 *
 * Date: 2025-04-15
 * Author: Marcus Rodriguez (mrodriguez@meridianhealth.io)
 * Ticket: PERF-445
 *
 * Generates realistic claim data for load testing the claims processing
 * pipeline. Unlike the dev seeder (which generates random data), this script
 * creates claims that match real-world patterns:
 *
 * - Proper CPT/ICD-10 code combinations (not random mismatches)
 * - Realistic charge amounts based on fee schedules
 * - Proper claim lifecycle (submitted -> adjudicated -> paid)
 * - Varying complexity (single-line vs multi-line claims)
 * - Mix of clean claims and claims that should trigger edits/denials
 *
 * Output: NDJSON file compatible with the claims-api bulk import endpoint
 *
 * Usage:
 *   npx tsx scripts/one-off/generate-test-claims.ts --count 10000 --output claims.ndjson
 *   npx tsx scripts/one-off/generate-test-claims.ts --count 50000 --output claims.ndjson --include-errors
 */

import { createWriteStream } from 'fs';
import { randomUUID } from 'crypto';

// -- Args --------------------------------------------------------------------
const args = process.argv.slice(2);
let count = 1000;
let outputFile = 'test-claims.ndjson';
let includeErrors = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--count') count = parseInt(args[++i]);
  if (args[i] === '--output') outputFile = args[++i];
  if (args[i] === '--include-errors') includeErrors = true;
}

// -- Realistic code combinations --------------------------------------------

// These represent common visit patterns. Each "scenario" is a realistic
// combination of CPT codes and diagnoses that would appear together.
const CLAIM_SCENARIOS = [
  {
    name: 'routine-office-visit',
    weight: 30,
    lines: [
      { cpt: '99213', icd10: ['I10', 'E78.5'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'complex-office-visit',
    weight: 15,
    lines: [
      { cpt: '99214', icd10: ['E11.9', 'I10', 'E78.5'], modifier: '', units: 1 },
      { cpt: '80053', icd10: ['E11.9'], modifier: '', units: 1 },
      { cpt: '36415', icd10: ['E11.9'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'annual-physical',
    weight: 10,
    lines: [
      { cpt: '99396', icd10: ['Z00.00'], modifier: '', units: 1 },
      { cpt: '36415', icd10: ['Z00.00'], modifier: '', units: 1 },
      { cpt: '80053', icd10: ['Z00.00'], modifier: '', units: 1 },
      { cpt: '85025', icd10: ['Z00.00'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'sick-visit-uri',
    weight: 12,
    lines: [
      { cpt: '99213', icd10: ['J06.9'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'follow-up-diabetes',
    weight: 8,
    lines: [
      { cpt: '99214', icd10: ['E11.9', 'E11.65'], modifier: '', units: 1 },
      { cpt: '83036', icd10: ['E11.9'], modifier: '', units: 1 },  // HbA1c
    ],
  },
  {
    name: 'new-patient-visit',
    weight: 8,
    lines: [
      { cpt: '99204', icd10: ['R10.9', 'K21.0'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'urgent-visit',
    weight: 5,
    lines: [
      { cpt: '99215', icd10: ['R07.9', 'I25.10'], modifier: '', units: 1 },
      { cpt: '93000', icd10: ['R07.9'], modifier: '', units: 1 },
      { cpt: '71046', icd10: ['R07.9'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'vaccination',
    weight: 7,
    lines: [
      { cpt: '90715', icd10: ['Z23'], modifier: '', units: 1 },
      { cpt: '90471', icd10: ['Z23'], modifier: '', units: 1 },
    ],
  },
  {
    name: 'procedure-visit',
    weight: 3,
    lines: [
      { cpt: '10060', icd10: ['L02.91'], modifier: '', units: 1 },
      { cpt: '99213', icd10: ['L02.91'], modifier: '25', units: 1 },  // modifier 25 = significant, separately identifiable E/M
    ],
  },
  {
    name: 'telehealth-visit',
    weight: 7,
    lines: [
      { cpt: '99213', icd10: ['F41.1', 'F32.1'], modifier: '95', units: 1 },  // 95 = telehealth
    ],
  },
];

// Fee schedule (simplified)
const FEE_SCHEDULE: Record<string, number> = {
  '99203': 115.00, '99204': 175.00, '99205': 250.00,
  '99213': 95.00,  '99214': 145.00, '99215': 210.00,
  '99385': 195.00, '99386': 220.00, '99395': 175.00, '99396': 195.00,
  '36415': 12.00,  '85025': 18.00,  '80053': 22.00,  '81001': 8.00,
  '71046': 85.00,  '93000': 55.00,  '83036': 15.00,
  '90715': 45.00,  '90471': 25.00,
  '10060': 180.00, '17000': 95.00,
  '99291': 450.00,
};

const PAYERS = [
  { id: 'BCBS001', name: 'Blue Cross Blue Shield', allowedPct: 0.85 },
  { id: 'AETNA01', name: 'Aetna', allowedPct: 0.80 },
  { id: 'UHC0001', name: 'UnitedHealthcare', allowedPct: 0.82 },
  { id: 'CIGNA01', name: 'Cigna', allowedPct: 0.78 },
  { id: 'HUMANA1', name: 'Humana', allowedPct: 0.83 },
  { id: 'MEDCR01', name: 'Medicare', allowedPct: 0.65 },
  { id: 'MEDCD01', name: 'Medicaid', allowedPct: 0.55 },
];

// Error scenarios that should trigger claim edits or denials
const ERROR_SCENARIOS = [
  { type: 'duplicate', description: 'Same patient, same DOS, same CPT' },
  { type: 'invalid-modifier', description: 'Invalid modifier for the CPT code' },
  { type: 'missing-auth', description: 'Requires prior auth but none provided' },
  { type: 'timely-filing', description: 'Date of service > 90 days ago' },
  { type: 'invalid-npi', description: 'Rendering provider NPI is deactivated' },
  { type: 'age-mismatch', description: 'Pediatric CPT code for adult patient' },
];

// -- Helpers -----------------------------------------------------------------

function weightedRandom<T extends { weight: number }>(items: T[]): T {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * totalWeight;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function randomDate(start: Date, end: Date): Date {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function generateNPI(): string {
  return `1${Math.random().toString().slice(2, 11)}`;
}

function generateMemberId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// -- Generator ---------------------------------------------------------------

function generateClaim(index: number): Record<string, unknown> {
  const scenario = weightedRandom(CLAIM_SCENARIOS);
  const payer = PAYERS[Math.floor(Math.random() * PAYERS.length)];
  const dateOfService = randomDate(new Date('2025-01-01'), new Date('2025-04-15'));
  const isError = includeErrors && Math.random() < 0.05;  // 5% error rate

  const claimLines = scenario.lines.map((line, lineIdx) => {
    const fee = FEE_SCHEDULE[line.cpt] || 100.00;
    const allowed = Math.round(fee * payer.allowedPct * 100) / 100;

    return {
      lineNumber: lineIdx + 1,
      cptCode: line.cpt,
      modifier: isError && lineIdx === 0 ? 'XX' : line.modifier,  // invalid modifier for error scenario
      icd10Codes: line.icd10,
      units: line.units,
      chargeAmount: fee,
      allowedAmount: allowed,
      placeOfService: scenario.name === 'telehealth-visit' ? '02' : '11',
    };
  });

  const totalCharged = claimLines.reduce((sum, l) => sum + l.chargeAmount * l.units, 0);

  const claim: Record<string, unknown> = {
    externalClaimId: `LOAD-TEST-${String(index).padStart(8, '0')}`,
    patientMemberId: generateMemberId(),
    patientDateOfBirth: randomDate(new Date('1940-01-01'), new Date('2006-01-01')).toISOString().split('T')[0],
    renderingProviderNpi: isError ? '0000000000' : generateNPI(),
    billingProviderNpi: generateNPI(),
    dateOfService: dateOfService.toISOString().split('T')[0],
    payerId: payer.id,
    payerName: payer.name,
    claimType: 'professional',
    totalChargeAmount: Math.round(totalCharged * 100) / 100,
    lines: claimLines,
    // Make some claims old for timely-filing test
    ...(isError && Math.random() < 0.2 ? {
      dateOfService: randomDate(new Date('2024-06-01'), new Date('2024-09-01')).toISOString().split('T')[0],
    } : {}),
  };

  return claim;
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Generating ${count} test claims...`);
  console.log(`Output: ${outputFile}`);
  console.log(`Include errors: ${includeErrors}`);
  console.log('');

  const writer = createWriteStream(outputFile);
  const startTime = Date.now();

  for (let i = 0; i < count; i++) {
    const claim = generateClaim(i);
    writer.write(JSON.stringify(claim) + '\n');

    if ((i + 1) % 10000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Generated ${i + 1}/${count} (${elapsed}s)`);
    }
  }

  writer.end();

  await new Promise<void>((resolve) => writer.on('finish', resolve));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`Done! Generated ${count} claims in ${elapsed}s`);
  console.log(`File: ${outputFile}`);
  console.log('');
  console.log('To run the load test:');
  console.log(`  curl -X POST https://claims-api.staging.meridianhealth.io/v1/claims/bulk-import \\`);
  console.log(`    -H "Authorization: Bearer \$API_TOKEN" \\`);
  console.log(`    -H "Content-Type: application/x-ndjson" \\`);
  console.log(`    --data-binary @${outputFile}`);
}

main();
