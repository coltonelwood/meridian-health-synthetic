/**
 * Import ICD-10-CM Code Set from CMS
 * ====================================
 *
 * Author: Sarah Chen (schen@meridianhealth.io)
 * Created: 2023-09-10
 * Last Modified: 2025-10-01 by schen (FY2026 update)
 *
 * Imports the ICD-10-CM diagnosis code set from CMS data files. CMS releases
 * a new version each fiscal year (October 1). We need to import the new codes
 * and mark deleted codes as inactive.
 *
 * Data source: https://www.cms.gov/medicare/coding-billing/icd-10-codes
 *
 * The CMS zip file contains several files. We use:
 *   - icd10cm_tabular_FYXXXX.xml (full code set with descriptions)
 *   - icd10cm_order_FYXXXX.txt (flat file with codes in tabular order)
 *
 * We use the .txt file because it's simpler to parse, even though the XML
 * has more detail (we don't need the clinical notes for our purposes).
 *
 * Run annually (or when CMS releases mid-year updates):
 *   npx tsx scripts/etl/import-icd10-codes.ts --file /data/icd10cm_order_2026.txt --fiscal-year 2026
 *   npx tsx scripts/etl/import-icd10-codes.ts --file /data/icd10cm_order_2026.txt --fiscal-year 2026 --dry-run
 */

import { Pool } from 'pg';
import { readFileSync } from 'fs';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// -- Parse args --------------------------------------------------------------
const args = process.argv.slice(2);
let inputFile = '';
let fiscalYear = new Date().getFullYear();
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') inputFile = args[++i];
  if (args[i] === '--fiscal-year') fiscalYear = parseInt(args[++i]);
  if (args[i] === '--dry-run') dryRun = true;
}

if (!inputFile) {
  console.error('Usage: npx tsx import-icd10-codes.ts --file <path> --fiscal-year <year> [--dry-run]');
  process.exit(1);
}

// -- Parse the CMS order file ------------------------------------------------
//
// The CMS order file is a fixed-width text file with the following layout:
//   Col 1-5:     Order number (right-justified)
//   Col 7-13:    ICD-10-CM code (no periods)
//   Col 15:      Header flag (0 = billable code, 1 = header/category)
//   Col 17-77:   Short description (60 chars)
//   Col 78-end:  Long description
//
// Example line:
//   00001 A000  1 Cholera due to Vibrio cholerae 01, biovar cholerae                  Cholera due to Vibrio cholerae 01, biovar cholerae

interface ICD10Code {
  orderNumber: number;
  code: string;
  formattedCode: string;  // with period, e.g., A00.0
  isHeader: boolean;
  shortDescription: string;
  longDescription: string;
}

function formatICD10Code(rawCode: string): string {
  // ICD-10 codes have a period after the 3rd character: A000 -> A00.0
  if (rawCode.length <= 3) return rawCode;
  return rawCode.substring(0, 3) + '.' + rawCode.substring(3);
}

function parseCMSFile(filePath: string): ICD10Code[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const codes: ICD10Code[] = [];

  for (const line of lines) {
    if (line.length < 17) continue;  // skip malformed lines

    try {
      const orderNumber = parseInt(line.substring(0, 5).trim());
      const rawCode = line.substring(6, 13).trim();
      const isHeader = line.charAt(14) === '1';
      const shortDescription = line.substring(16, 77).trim();
      const longDescription = line.length > 77 ? line.substring(77).trim() : shortDescription;

      if (!rawCode) continue;

      codes.push({
        orderNumber,
        code: rawCode,
        formattedCode: formatICD10Code(rawCode),
        isHeader,
        shortDescription,
        longDescription,
      });
    } catch {
      // Some lines in the CMS file are blank or have weird formatting
      // Just skip them
      continue;
    }
  }

  return codes;
}

// -- Database operations -----------------------------------------------------

async function importCodes(codes: ICD10Code[]): Promise<{
  inserted: number;
  updated: number;
  deactivated: number;
}> {
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let deactivated = 0;

  try {
    await client.query('BEGIN');

    // First, get all existing codes
    const existing = await client.query(
      'SELECT code, short_description, long_description, is_header, is_active, fiscal_year FROM icd10_codes'
    );

    const existingMap = new Map<string, typeof existing.rows[0]>();
    for (const row of existing.rows) {
      existingMap.set(row.code, row);
    }

    console.log(`Existing codes in database: ${existingMap.size}`);
    console.log(`Codes in import file: ${codes.length}`);

    // Track which codes are in the new file
    const newCodeSet = new Set(codes.map(c => c.formattedCode));

    // Insert or update codes from the file
    const BATCH_SIZE = 500;
    for (let i = 0; i < codes.length; i += BATCH_SIZE) {
      const batch = codes.slice(i, i + BATCH_SIZE);

      for (const code of batch) {
        const existingCode = existingMap.get(code.formattedCode);

        if (!existingCode) {
          // New code
          if (!dryRun) {
            await client.query(`
              INSERT INTO icd10_codes (
                code, short_description, long_description, is_header,
                is_active, fiscal_year, effective_date, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, true, $5, $6, NOW(), NOW())
            `, [
              code.formattedCode, code.shortDescription, code.longDescription,
              code.isHeader, fiscalYear,
              `${fiscalYear - 1}-10-01`,  // FY starts Oct 1 of previous calendar year
            ]);
          }
          inserted++;
        } else if (
          existingCode.short_description !== code.shortDescription ||
          existingCode.long_description !== code.longDescription ||
          existingCode.is_header !== code.isHeader ||
          !existingCode.is_active
        ) {
          // Updated code
          if (!dryRun) {
            await client.query(`
              UPDATE icd10_codes
              SET short_description = $1,
                  long_description = $2,
                  is_header = $3,
                  is_active = true,
                  fiscal_year = $4,
                  updated_at = NOW()
              WHERE code = $5
            `, [
              code.shortDescription, code.longDescription,
              code.isHeader, fiscalYear, code.formattedCode,
            ]);
          }
          updated++;
        }
      }

      if ((i + BATCH_SIZE) % 5000 < BATCH_SIZE) {
        console.log(`  Processed ${Math.min(i + BATCH_SIZE, codes.length)}/${codes.length}...`);
      }
    }

    // Deactivate codes that are no longer in the file
    // (but don't delete them - they might be referenced by historical claims)
    for (const [existingCode, row] of existingMap) {
      if (!newCodeSet.has(existingCode) && row.is_active) {
        if (!dryRun) {
          await client.query(`
            UPDATE icd10_codes
            SET is_active = false,
                end_date = $1,
                updated_at = NOW()
            WHERE code = $2
          `, [`${fiscalYear - 1}-09-30`, existingCode]);
        }
        deactivated++;
      }
    }

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    return { inserted, updated, deactivated };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== ICD-10-CM Import ===');
  console.log(`File: ${inputFile}`);
  console.log(`Fiscal Year: ${fiscalYear}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  // Parse the file
  console.log('Parsing CMS file...');
  const codes = parseCMSFile(inputFile);

  const billable = codes.filter(c => !c.isHeader);
  const headers = codes.filter(c => c.isHeader);

  console.log(`  Total entries: ${codes.length}`);
  console.log(`  Billable codes: ${billable.length}`);
  console.log(`  Category headers: ${headers.length}`);
  console.log('');

  // Show some sample codes
  console.log('Sample codes:');
  for (const code of codes.slice(0, 5)) {
    console.log(`  ${code.formattedCode} ${code.isHeader ? '(H)' : '   '} ${code.shortDescription}`);
  }
  console.log('  ...');
  console.log('');

  // Import
  console.log('Importing...');
  const result = await importCodes(codes);

  console.log('');
  console.log('=== Results ===');
  console.log(`  New codes added:  ${result.inserted}`);
  console.log(`  Codes updated:    ${result.updated}`);
  console.log(`  Codes deactivated: ${result.deactivated}`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (result.deactivated > 0) {
    console.log('');
    console.log(`  NOTE: ${result.deactivated} codes were deactivated. These may be referenced`);
    console.log('  by historical claims. The codes are kept in the database but marked inactive.');
    console.log('  The claim validation service will reject new claims using deactivated codes.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
