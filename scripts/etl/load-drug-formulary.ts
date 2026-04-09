/**
 * Load Drug Formulary Data from Payer Files
 * ===========================================
 *
 * Author: Marcus Rodriguez (mrodriguez@meridianhealth.io)
 * Created: 2024-03-15
 * Last Modified: 2025-12-02 by mrodriguez
 *
 * Loads drug formulary data from various payer files. Each payer sends us
 * their formulary in a different format (of course) so we have to handle
 * each one separately.
 *
 * Payer formats:
 *   - BCBS: CSV with headers, pipe-delimited (they say it's CSV but it's not)
 *   - Aetna: Excel (.xlsx) with multiple sheets
 *   - UHC: Fixed-width text file (seriously, it's 2025)
 *   - Cigna: JSON (the only sane one)
 *   - Humana: XML because they hate us
 *   - Medicare: CMS formulary file format (another fixed-width)
 *
 * Run quarterly when payers send updated formularies:
 *   npx tsx scripts/etl/load-drug-formulary.ts --payer bcbs --file /data/formulary/bcbs_2025q4.csv
 *   npx tsx scripts/etl/load-drug-formulary.ts --payer all --dir /data/formulary/2025q4/
 *
 * TODO(mrodriguez): This whole file is a mess. Each payer parser was written
 * at different times when we onboarded them, and they all have slightly
 * different error handling. Should refactor into a proper plugin architecture
 * but it works and I don't want to touch it.
 */

import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { parse as csvParse } from 'csv-parse/sync';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Parse args
const args = process.argv.slice(2);
let payerArg = '';
let inputFile = '';
let inputDir = '';
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--payer') payerArg = args[++i];
  if (args[i] === '--file') inputFile = args[++i];
  if (args[i] === '--dir') inputDir = args[++i];
  if (args[i] === '--dry-run') dryRun = true;
}

if (!payerArg) {
  console.error('Usage: npx tsx load-drug-formulary.ts --payer <payer|all> --file <path> | --dir <path> [--dry-run]');
  process.exit(1);
}

// -- Types -------------------------------------------------------------------

interface FormularyEntry {
  ndc: string;
  drugName: string;
  genericName: string;
  strength: string;
  dosageForm: string;
  tier: number;  // 1-5, where 1 = preferred generic, 5 = specialty
  tierDescription: string;
  requiresPriorAuth: boolean;
  requiresStepTherapy: boolean;
  quantityLimit: number | null;
  quantityLimitDays: number | null;
  copayAmount: number | null;
  coinsurancePercent: number | null;
  effectiveDate: string;
  terminationDate: string | null;
}

// -- Payer-specific parsers --------------------------------------------------
// Each of these is gnarly in its own special way

function parseBCBS(filePath: string): FormularyEntry[] {
  // BCBS sends "CSV" files that are actually pipe-delimited
  // Also, they sometimes include a BOM at the start of the file
  // Also, they quote some fields but not others
  // Also, the column names change slightly between quarterly updates
  const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const records = csvParse(raw, {
    delimiter: '|',
    columns: true,
    skip_empty_lines: true,
    relaxColumnCount: true,  // some rows have extra pipes at the end
    trim: true,
  });

  return records.map((r: Record<string, string>) => ({
    ndc: (r['NDC'] || r['NDC_Code'] || r['ndc']).replace(/-/g, '').padStart(11, '0'),
    drugName: r['Drug Name'] || r['DrugName'] || r['DRUG_NAME'] || '',
    genericName: r['Generic Name'] || r['GenericName'] || r['GENERIC_NAME'] || '',
    strength: r['Strength'] || r['STRENGTH'] || '',
    dosageForm: r['Dosage Form'] || r['DosageForm'] || r['DOSAGE_FORM'] || '',
    tier: parseInt(r['Tier'] || r['TIER'] || '3'),
    tierDescription: r['Tier Description'] || r['TierDesc'] || `Tier ${r['Tier'] || '3'}`,
    requiresPriorAuth: ['Y', 'Yes', 'TRUE', '1'].includes(r['Prior Auth'] || r['PA'] || ''),
    requiresStepTherapy: ['Y', 'Yes', 'TRUE', '1'].includes(r['Step Therapy'] || r['ST'] || ''),
    quantityLimit: r['QL'] && r['QL'] !== 'N/A' ? parseInt(r['QL']) : null,
    quantityLimitDays: r['QL Days'] ? parseInt(r['QL Days']) : null,
    copayAmount: r['Copay'] ? parseFloat(r['Copay'].replace('$', '')) : null,
    coinsurancePercent: r['Coinsurance'] ? parseFloat(r['Coinsurance'].replace('%', '')) : null,
    effectiveDate: r['Effective Date'] || r['EffDate'] || new Date().toISOString().split('T')[0],
    terminationDate: r['Term Date'] || r['TermDate'] || null,
  }));
}

function parseUHC(filePath: string): FormularyEntry[] {
  // UHC sends fixed-width files. I'm not making this up.
  // Layout from their spec document (which is a PDF, of course):
  //   1-11:   NDC (11 digits)
  //   12-71:  Drug name (60 chars)
  //   72-111: Generic name (40 chars)
  //   112-131: Strength (20 chars)
  //   132-151: Dosage form (20 chars)
  //   152:    Tier (1 char)
  //   153:    Prior auth flag (Y/N)
  //   154:    Step therapy flag (Y/N)
  //   155-160: Quantity limit (6 chars, right-justified)
  //   161-166: QL days (6 chars)
  //   167-174: Copay amount (8 chars, 2 decimal places implied)
  //   175-177: Coinsurance percent (3 chars)
  //   178-187: Effective date (YYYY-MM-DD)
  //   188-197: Term date (YYYY-MM-DD or spaces)

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length >= 178);

  // Skip header line if present
  const dataLines = lines[0].substring(0, 3) === 'NDC' ? lines.slice(1) : lines;

  return dataLines.map(line => {
    const copayRaw = line.substring(166, 174).trim();
    const coinsRaw = line.substring(174, 177).trim();
    const qlRaw = line.substring(154, 160).trim();
    const qlDaysRaw = line.substring(160, 166).trim();
    const termDate = line.substring(187, 197).trim();

    return {
      ndc: line.substring(0, 11).trim(),
      drugName: line.substring(11, 71).trim(),
      genericName: line.substring(71, 111).trim(),
      strength: line.substring(111, 131).trim(),
      dosageForm: line.substring(131, 151).trim(),
      tier: parseInt(line.charAt(151)) || 3,
      tierDescription: `Tier ${line.charAt(151) || '3'}`,
      requiresPriorAuth: line.charAt(152) === 'Y',
      requiresStepTherapy: line.charAt(153) === 'Y',
      quantityLimit: qlRaw ? parseInt(qlRaw) : null,
      quantityLimitDays: qlDaysRaw ? parseInt(qlDaysRaw) : null,
      copayAmount: copayRaw ? parseInt(copayRaw) / 100 : null,
      coinsurancePercent: coinsRaw ? parseInt(coinsRaw) : null,
      effectiveDate: line.substring(177, 187).trim(),
      terminationDate: termDate.length === 10 ? termDate : null,
    };
  });
}

function parseCigna(filePath: string): FormularyEntry[] {
  // Cigna sends JSON. Bless them.
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));

  // But of course the schema changes between quarters without warning
  const drugs = data.formulary || data.drugs || data.items || [];

  return drugs.map((d: Record<string, unknown>) => ({
    ndc: String(d.ndc || d.NDC || '').replace(/-/g, '').padStart(11, '0'),
    drugName: String(d.drugName || d.drug_name || d.name || ''),
    genericName: String(d.genericName || d.generic_name || d.generic || ''),
    strength: String(d.strength || ''),
    dosageForm: String(d.dosageForm || d.dosage_form || d.form || ''),
    tier: Number(d.tier || d.formularyTier || 3),
    tierDescription: String(d.tierDescription || d.tier_description || `Tier ${d.tier || 3}`),
    requiresPriorAuth: Boolean(d.priorAuth || d.prior_auth || d.pa || false),
    requiresStepTherapy: Boolean(d.stepTherapy || d.step_therapy || d.st || false),
    quantityLimit: d.quantityLimit != null ? Number(d.quantityLimit) : null,
    quantityLimitDays: d.quantityLimitDays != null ? Number(d.quantityLimitDays) : null,
    copayAmount: d.copay != null ? Number(d.copay) : null,
    coinsurancePercent: d.coinsurance != null ? Number(d.coinsurance) : null,
    effectiveDate: String(d.effectiveDate || d.effective_date || new Date().toISOString().split('T')[0]),
    terminationDate: d.terminationDate || d.termination_date || null,
  }));
}

function parseHumana(filePath: string): FormularyEntry[] {
  // Humana sends XML. Because of course they do.
  // We use a quick and dirty regex-based parser because adding an XML library
  // dependency for one payer's quarterly file seemed overkill.
  // (mrodriguez: yes I know this is terrible. It works.)

  const xml = readFileSync(filePath, 'utf-8');
  const entries: FormularyEntry[] = [];

  // Match each <Drug> element
  const drugRegex = /<Drug>([\s\S]*?)<\/Drug>/g;
  let match;

  while ((match = drugRegex.exec(xml)) !== null) {
    const drugXml = match[1];

    const getTag = (tag: string): string => {
      const m = drugXml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1].trim() : '';
    };

    entries.push({
      ndc: getTag('NDC').replace(/-/g, '').padStart(11, '0'),
      drugName: getTag('DrugName') || getTag('BrandName'),
      genericName: getTag('GenericName'),
      strength: getTag('Strength'),
      dosageForm: getTag('DosageForm'),
      tier: parseInt(getTag('Tier')) || 3,
      tierDescription: getTag('TierDescription') || `Tier ${getTag('Tier') || '3'}`,
      requiresPriorAuth: getTag('PriorAuth') === 'true' || getTag('PriorAuth') === 'Y',
      requiresStepTherapy: getTag('StepTherapy') === 'true' || getTag('StepTherapy') === 'Y',
      quantityLimit: getTag('QuantityLimit') ? parseInt(getTag('QuantityLimit')) : null,
      quantityLimitDays: getTag('QuantityLimitDays') ? parseInt(getTag('QuantityLimitDays')) : null,
      copayAmount: getTag('Copay') ? parseFloat(getTag('Copay')) : null,
      coinsurancePercent: getTag('Coinsurance') ? parseFloat(getTag('Coinsurance')) : null,
      effectiveDate: getTag('EffectiveDate') || new Date().toISOString().split('T')[0],
      terminationDate: getTag('TerminationDate') || null,
    });
  }

  return entries;
}

function parseAetna(_filePath: string): FormularyEntry[] {
  // Aetna sends .xlsx files with multiple sheets
  // We'd need xlsx/exceljs library for this. For now, we require the ops
  // team to export the relevant sheet as CSV before running this script.
  // TODO(mrodriguez): Actually implement xlsx parsing. This has been a TODO
  // since March 2024 and nobody has complained enough to justify the work.
  console.error('ERROR: Aetna format requires pre-conversion to CSV.');
  console.error('Please export the "Formulary" sheet from the Excel file as CSV');
  console.error('and use --payer bcbs (the BCBS parser handles generic CSVs)');
  process.exit(1);
  return []; // unreachable but TypeScript wants it
}

function parseMedicare(filePath: string): FormularyEntry[] {
  // CMS formulary file format - similar to UHC fixed-width but different layout
  // Spec: https://www.cms.gov/Medicare/Prescription-Drug-Coverage/PrescriptionDrugCovContra
  // (good luck finding the actual spec on that maze of a website)

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  return lines.slice(1).map(line => { // skip header
    const fields = line.split('|');  // Medicare actually uses pipe delimited, phew
    return {
      ndc: (fields[0] || '').padStart(11, '0'),
      drugName: fields[1] || '',
      genericName: fields[2] || '',
      strength: fields[3] || '',
      dosageForm: fields[4] || '',
      tier: parseInt(fields[5]) || 3,
      tierDescription: fields[6] || `Tier ${fields[5] || '3'}`,
      requiresPriorAuth: fields[7] === 'Y',
      requiresStepTherapy: fields[8] === 'Y',
      quantityLimit: fields[9] ? parseInt(fields[9]) : null,
      quantityLimitDays: fields[10] ? parseInt(fields[10]) : null,
      copayAmount: fields[11] ? parseFloat(fields[11]) : null,
      coinsurancePercent: fields[12] ? parseFloat(fields[12]) : null,
      effectiveDate: fields[13] || new Date().toISOString().split('T')[0],
      terminationDate: fields[14]?.trim() || null,
    };
  });
}

// -- Router ------------------------------------------------------------------
// Yes, this is an ugly switch statement. See the TODO at the top of the file.

function parseFile(payer: string, filePath: string): FormularyEntry[] {
  console.log(`Parsing ${payer} file: ${filePath}`);

  switch (payer.toLowerCase()) {
    case 'bcbs':
      return parseBCBS(filePath);
    case 'uhc':
    case 'unitedhealthcare':
      return parseUHC(filePath);
    case 'cigna':
      return parseCigna(filePath);
    case 'humana':
      return parseHumana(filePath);
    case 'aetna':
      return parseAetna(filePath);
    case 'medicare':
    case 'cms':
      return parseMedicare(filePath);
    default:
      console.error(`Unknown payer: ${payer}`);
      console.error('Supported payers: bcbs, uhc, cigna, humana, aetna, medicare');
      process.exit(1);
      return [];
  }
}

// -- Database ----------------------------------------------------------------

async function loadEntries(payerId: string, entries: FormularyEntry[]): Promise<{
  inserted: number;
  updated: number;
}> {
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;

  try {
    await client.query('BEGIN');

    for (const entry of entries) {
      // Skip entries with obviously bad NDC codes
      if (!entry.ndc || entry.ndc.length !== 11 || entry.ndc === '00000000000') {
        continue;
      }

      const existing = await client.query(
        'SELECT id FROM drug_formulary WHERE payer_id = $1 AND ndc = $2',
        [payerId, entry.ndc]
      );

      if (existing.rows.length > 0) {
        if (!dryRun) {
          await client.query(`
            UPDATE drug_formulary SET
              drug_name = $1, generic_name = $2, strength = $3, dosage_form = $4,
              tier = $5, tier_description = $6, requires_prior_auth = $7,
              requires_step_therapy = $8, quantity_limit = $9, quantity_limit_days = $10,
              copay_amount = $11, coinsurance_percent = $12,
              effective_date = $13, termination_date = $14,
              updated_at = NOW()
            WHERE payer_id = $15 AND ndc = $16
          `, [
            entry.drugName, entry.genericName, entry.strength, entry.dosageForm,
            entry.tier, entry.tierDescription, entry.requiresPriorAuth,
            entry.requiresStepTherapy, entry.quantityLimit, entry.quantityLimitDays,
            entry.copayAmount, entry.coinsurancePercent,
            entry.effectiveDate, entry.terminationDate,
            payerId, entry.ndc,
          ]);
        }
        updated++;
      } else {
        if (!dryRun) {
          await client.query(`
            INSERT INTO drug_formulary (
              payer_id, ndc, drug_name, generic_name, strength, dosage_form,
              tier, tier_description, requires_prior_auth, requires_step_therapy,
              quantity_limit, quantity_limit_days, copay_amount, coinsurance_percent,
              effective_date, termination_date, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
          `, [
            payerId, entry.ndc, entry.drugName, entry.genericName,
            entry.strength, entry.dosageForm, entry.tier, entry.tierDescription,
            entry.requiresPriorAuth, entry.requiresStepTherapy,
            entry.quantityLimit, entry.quantityLimitDays,
            entry.copayAmount, entry.coinsurancePercent,
            entry.effectiveDate, entry.terminationDate,
          ]);
        }
        inserted++;
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, updated };
}

// -- Main --------------------------------------------------------------------

const PAYER_IDS: Record<string, string> = {
  'bcbs': 'BCBS001',
  'aetna': 'AETNA01',
  'uhc': 'UHC0001',
  'unitedhealthcare': 'UHC0001',
  'cigna': 'CIGNA01',
  'humana': 'HUMANA1',
  'medicare': 'MEDCR01',
  'cms': 'MEDCR01',
};

async function main(): Promise<void> {
  console.log('=== Drug Formulary Loader ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  if (payerArg === 'all' && inputDir) {
    // Process all files in directory
    const files = readdirSync(inputDir);
    console.log(`Found ${files.length} files in ${inputDir}`);

    for (const file of files) {
      // Try to determine payer from filename
      const lowerFile = file.toLowerCase();
      let payer = '';
      for (const [key] of Object.entries(PAYER_IDS)) {
        if (lowerFile.includes(key)) {
          payer = key;
          break;
        }
      }

      if (!payer) {
        console.log(`  Skipping ${file} (couldn't determine payer)`);
        continue;
      }

      const entries = parseFile(payer, `${inputDir}/${file}`);
      const payerId = PAYER_IDS[payer];
      console.log(`  ${payer}: ${entries.length} entries`);

      const result = await loadEntries(payerId, entries);
      console.log(`    Inserted: ${result.inserted}, Updated: ${result.updated}`);
    }
  } else if (inputFile) {
    const entries = parseFile(payerArg, inputFile);
    const payerId = PAYER_IDS[payerArg.toLowerCase()];

    if (!payerId) {
      console.error(`Unknown payer: ${payerArg}`);
      process.exit(1);
    }

    console.log(`Parsed ${entries.length} formulary entries`);

    // Show tier distribution
    const tierCounts: Record<number, number> = {};
    for (const e of entries) {
      tierCounts[e.tier] = (tierCounts[e.tier] || 0) + 1;
    }
    console.log('Tier distribution:');
    for (const [tier, count] of Object.entries(tierCounts).sort()) {
      console.log(`  Tier ${tier}: ${count}`);
    }
    console.log('');

    const result = await loadEntries(payerId, entries);
    console.log(`Inserted: ${result.inserted}`);
    console.log(`Updated: ${result.updated}`);
  } else {
    console.error('Either --file or --dir is required');
    process.exit(1);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
