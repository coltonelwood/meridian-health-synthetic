import { Pool, PoolClient } from 'pg';
import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import ProgressBar from 'progress';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { detectEncoding, normalizeEncoding } from '../utils/csvHelper';
import { validatePatient, ValidationError } from '../utils/dataValidator';

interface MigratorOptions {
  batchSize: number;
  dryRun: boolean;
  skipValidation: boolean;
  source: string;
  resumeFrom?: number;
}

interface MigrationResult {
  totalRows: number;
  inserted: number;
  skipped: number;
  errors: number;
  errorDetails: { line: number; message: string; data?: any }[];
  errorLogPath: string;
}

// Legacy system field mapping - the old EHR uses completely different column names
// and some fields are crammed together or split differently
const LEGACY_FIELD_MAP: Record<string, string> = {
  'PAT_ID': 'legacy_id',
  'PATIENT_ID': 'legacy_id', // some exports use this instead
  'PT_FIRST': 'first_name',
  'FIRST_NAME': 'first_name',
  'PT_LAST': 'last_name',
  'LAST_NAME': 'last_name',
  'PT_MIDDLE': 'middle_name',
  'MIDDLE': 'middle_name',
  'PT_DOB': 'date_of_birth',
  'BIRTH_DATE': 'date_of_birth',
  'DOB': 'date_of_birth',
  'PT_SSN': 'ssn',
  'SSN': 'ssn',
  'SOC_SEC': 'ssn', // really old exports use this
  'PT_SEX': 'gender',
  'GENDER': 'gender',
  'SEX': 'gender',
  'PT_ADDR1': 'address_line1',
  'ADDRESS': 'address_line1',
  'ADDRESS_1': 'address_line1',
  'PT_ADDR2': 'address_line2',
  'ADDRESS_2': 'address_line2',
  'PT_CITY': 'city',
  'CITY': 'city',
  'PT_STATE': 'state',
  'STATE': 'state',
  'PT_ZIP': 'zip_code',
  'ZIP': 'zip_code',
  'ZIPCODE': 'zip_code',
  'PT_PHONE': 'phone',
  'PHONE': 'phone',
  'PHONE_HOME': 'phone',
  'PT_EMAIL': 'email',
  'EMAIL': 'email',
  'EMAIL_ADDR': 'email',
  'INS_ID': 'insurance_id',
  'INSURANCE_ID': 'insurance_id',
  'INS_NAME': 'insurer_name',
  'INSURANCE_CO': 'insurer_name',
  'PROV_NPI': 'primary_provider_npi',
  'PCP_NPI': 'primary_provider_npi',
  'PRIMARY_PROVIDER': 'primary_provider_npi',
  'PT_STATUS': 'status',
  'STATUS': 'status',
  'ACTIVE_FLAG': 'status', // 'Y'/'N' - needs special handling
};

export class PatientMigrator {
  private pool: Pool;
  private options: MigratorOptions;
  private errorLogPath: string;

  constructor(pool: Pool, options: MigratorOptions) {
    this.pool = pool;
    this.options = options;
    this.errorLogPath = join(process.cwd(), `migration-errors-${Date.now()}.log`);
  }

  async migrate(filePath: string): Promise<MigrationResult> {
    const result: MigrationResult = {
      totalRows: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      errorDetails: [],
      errorLogPath: this.errorLogPath,
    };

    // detect file encoding - legacy system sometimes exports as Windows-1252
    // instead of UTF-8, which corrupts names with accents
    const encoding = await detectEncoding(filePath);
    console.log(`Detected encoding: ${encoding}`);

    const records: any[] = [];
    let lineNum = 0;

    // Phase 1: Read and parse the CSV
    const parser = createReadStream(filePath)
      .pipe(normalizeEncoding(encoding))
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        // legacy exports sometimes have BOM characters
        bom: true,
        // relax quoting rules - the old system doesn't properly escape quotes
        relax_quotes: true,
        relax_column_count: true, // some rows have extra trailing commas
      }));

    for await (const record of parser) {
      lineNum++;

      if (this.options.resumeFrom && lineNum < this.options.resumeFrom) {
        continue;
      }

      result.totalRows++;

      // normalize field names from whatever the legacy system used
      const normalized = this.normalizeFields(record);

      // clean the data
      const cleaned = this.cleanPatientData(normalized);

      // validate unless explicitly skipped
      if (!this.options.skipValidation) {
        try {
          validatePatient(cleaned);
        } catch (err) {
          const validationErr = err as ValidationError;
          result.errors++;
          const detail = {
            line: lineNum,
            message: validationErr.message,
            data: cleaned,
          };
          result.errorDetails.push(detail);
          this.logError(detail);
          continue;
        }
      }

      records.push({ ...cleaned, _lineNum: lineNum });

      // Process in batches
      if (records.length >= this.options.batchSize) {
        const batchResult = await this.insertBatch(records.splice(0));
        result.inserted += batchResult.inserted;
        result.skipped += batchResult.skipped;
        result.errors += batchResult.errors;
        batchResult.errorDetails.forEach(e => {
          result.errorDetails.push(e);
          this.logError(e);
        });
      }
    }

    // Process remaining records
    if (records.length > 0) {
      const batchResult = await this.insertBatch(records);
      result.inserted += batchResult.inserted;
      result.skipped += batchResult.skipped;
      result.errors += batchResult.errors;
      batchResult.errorDetails.forEach(e => {
        result.errorDetails.push(e);
        this.logError(e);
      });
    }

    return result;
  }

  private normalizeFields(record: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
      const upperKey = key.toUpperCase().trim();
      const mappedKey = LEGACY_FIELD_MAP[upperKey];
      if (mappedKey) {
        // if we already have this field, don't overwrite (first match wins)
        if (!(mappedKey in normalized)) {
          normalized[mappedKey] = value;
        }
      }
      // silently drop unknown fields - there's always random garbage columns
    }

    return normalized;
  }

  private cleanPatientData(data: Record<string, string>): Record<string, any> {
    const cleaned: Record<string, any> = { ...data };

    // Name cleaning
    if (cleaned.first_name) {
      cleaned.first_name = this.cleanName(cleaned.first_name);
    }
    if (cleaned.last_name) {
      cleaned.last_name = this.cleanName(cleaned.last_name);
    }
    if (cleaned.middle_name) {
      cleaned.middle_name = this.cleanName(cleaned.middle_name);
    }

    // SSN cleaning - remove dashes, spaces
    if (cleaned.ssn) {
      cleaned.ssn = cleaned.ssn.replace(/[\s\-]/g, '');
      // some records have placeholder SSNs
      if (cleaned.ssn === '000000000' || cleaned.ssn === '999999999' || cleaned.ssn === '123456789') {
        cleaned.ssn = null;
      }
    }

    // Date of birth - legacy system uses like 5 different date formats
    if (cleaned.date_of_birth) {
      cleaned.date_of_birth = this.parseDate(cleaned.date_of_birth);
    }

    // Phone number - strip everything except digits
    if (cleaned.phone) {
      cleaned.phone = cleaned.phone.replace(/\D/g, '');
      // remove leading 1 for US numbers
      if (cleaned.phone.length === 11 && cleaned.phone.startsWith('1')) {
        cleaned.phone = cleaned.phone.substring(1);
      }
      // if it's not 10 digits, it's probably garbage
      if (cleaned.phone.length !== 10) {
        cleaned.phone = null;
      }
    }

    // Email - lowercase and trim
    if (cleaned.email) {
      cleaned.email = cleaned.email.toLowerCase().trim();
      // basic check - lots of legacy records have stuff like "N/A" or "NONE"
      if (!cleaned.email.includes('@') || cleaned.email === 'n/a' || cleaned.email === 'none') {
        cleaned.email = null;
      }
    }

    // ZIP code normalization
    if (cleaned.zip_code) {
      cleaned.zip_code = cleaned.zip_code.replace(/\s/g, '');
      // handle ZIP+4 - just take the first 5
      if (cleaned.zip_code.includes('-')) {
        cleaned.zip_code = cleaned.zip_code.split('-')[0];
      }
      // some records have full 9-digit zips without dash
      if (cleaned.zip_code.length === 9) {
        cleaned.zip_code = cleaned.zip_code.substring(0, 5);
      }
    }

    // Gender normalization - legacy system uses all kinds of values
    if (cleaned.gender) {
      const g = cleaned.gender.toUpperCase().trim();
      if (g === 'M' || g === 'MALE') cleaned.gender = 'male';
      else if (g === 'F' || g === 'FEMALE') cleaned.gender = 'female';
      else if (g === 'O' || g === 'OTHER' || g === 'NB') cleaned.gender = 'other';
      else if (g === 'U' || g === 'UNK' || g === 'UNKNOWN') cleaned.gender = 'unknown';
      else cleaned.gender = 'unknown'; // default to unknown rather than dropping
    }

    // Status normalization
    if (cleaned.status) {
      const s = cleaned.status.toUpperCase().trim();
      // ACTIVE_FLAG uses Y/N
      if (s === 'Y' || s === 'YES' || s === 'A' || s === 'ACTIVE') {
        cleaned.status = 'active';
      } else if (s === 'N' || s === 'NO' || s === 'I' || s === 'INACTIVE') {
        cleaned.status = 'inactive';
      } else if (s === 'D' || s === 'DECEASED' || s === 'DEAD') {
        cleaned.status = 'deceased';
      } else {
        cleaned.status = 'inactive'; // default to inactive if unknown
      }
    } else {
      cleaned.status = 'active'; // no status field = assume active
    }

    // State normalization - some records have full state names
    if (cleaned.state) {
      cleaned.state = this.normalizeState(cleaned.state);
    }

    return cleaned;
  }

  private cleanName(name: string): string {
    let cleaned = name.trim();
    // fix ALL CAPS names (surprisingly common in legacy data)
    if (cleaned === cleaned.toUpperCase() && cleaned.length > 1) {
      cleaned = cleaned.charAt(0) + cleaned.slice(1).toLowerCase();
    }
    // remove leading/trailing quotes that sometimes sneak in
    cleaned = cleaned.replace(/^["']|["']$/g, '');
    // remove double spaces
    cleaned = cleaned.replace(/\s+/g, ' ');
    return cleaned;
  }

  private parseDate(dateStr: string): string | null {
    if (!dateStr || dateStr.trim() === '') return null;

    const trimmed = dateStr.trim();

    // Try various formats the legacy system uses:
    const formats = [
      // MM/DD/YYYY
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
      // MM-DD-YYYY
      /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
      // YYYY-MM-DD (ISO, sometimes we get lucky)
      /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
      // YYYYMMDD (no separators, from batch exports)
      /^(\d{4})(\d{2})(\d{2})$/,
      // MM/DD/YY (two digit year, ugh)
      /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    ];

    // MM/DD/YYYY or MM-DD-YYYY
    let match = trimmed.match(formats[0]) || trimmed.match(formats[1]);
    if (match) {
      const [, month, day, year] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // YYYY-MM-DD
    match = trimmed.match(formats[2]);
    if (match) {
      const [, year, month, day] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // YYYYMMDD
    match = trimmed.match(formats[3]);
    if (match) {
      const [, year, month, day] = match;
      return `${year}-${month}-${day}`;
    }

    // MM/DD/YY - assume 2000s for years < 50, 1900s otherwise
    // this is the Y2K pivot year approach, not great but matches the legacy system
    match = trimmed.match(formats[4]);
    if (match) {
      const [, month, day, shortYear] = match;
      const year = parseInt(shortYear) < 50 ? `20${shortYear}` : `19${shortYear}`;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    // last resort: try to parse with Date constructor
    // this is unreliable but catches some edge cases
    try {
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
      }
    } catch {
      // fall through
    }

    return null;
  }

  private normalizeState(state: string): string {
    const stateMap: Record<string, string> = {
      'ALABAMA': 'AL', 'ALASKA': 'AK', 'ARIZONA': 'AZ', 'ARKANSAS': 'AR',
      'CALIFORNIA': 'CA', 'COLORADO': 'CO', 'CONNECTICUT': 'CT', 'DELAWARE': 'DE',
      'FLORIDA': 'FL', 'GEORGIA': 'GA', 'HAWAII': 'HI', 'IDAHO': 'ID',
      'ILLINOIS': 'IL', 'INDIANA': 'IN', 'IOWA': 'IA', 'KANSAS': 'KS',
      'KENTUCKY': 'KY', 'LOUISIANA': 'LA', 'MAINE': 'ME', 'MARYLAND': 'MD',
      'MASSACHUSETTS': 'MA', 'MICHIGAN': 'MI', 'MINNESOTA': 'MN', 'MISSISSIPPI': 'MS',
      'MISSOURI': 'MO', 'MONTANA': 'MT', 'NEBRASKA': 'NE', 'NEVADA': 'NV',
      'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
      'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', 'OHIO': 'OH', 'OKLAHOMA': 'OK',
      'OREGON': 'OR', 'PENNSYLVANIA': 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
      'SOUTH DAKOTA': 'SD', 'TENNESSEE': 'TN', 'TEXAS': 'TX', 'UTAH': 'UT',
      'VERMONT': 'VT', 'VIRGINIA': 'VA', 'WASHINGTON': 'WA', 'WEST VIRGINIA': 'WV',
      'WISCONSIN': 'WI', 'WYOMING': 'WY',
      // DC and territories
      'DISTRICT OF COLUMBIA': 'DC', 'PUERTO RICO': 'PR',
    };

    const upper = state.toUpperCase().trim();
    if (upper.length === 2) return upper; // already an abbreviation
    return stateMap[upper] || state; // return as-is if we can't map it
  }

  private async insertBatch(
    records: any[]
  ): Promise<{ inserted: number; skipped: number; errors: number; errorDetails: any[] }> {
    if (this.options.dryRun) {
      return { inserted: 0, skipped: records.length, errors: 0, errorDetails: [] };
    }

    const result = { inserted: 0, skipped: 0, errors: 0, errorDetails: [] as any[] };
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for (const record of records) {
        const lineNum = record._lineNum;
        delete record._lineNum;

        try {
          // check if patient already exists (by legacy_id or SSN)
          const existing = await client.query(
            `SELECT id FROM patients WHERE legacy_id = $1 OR (ssn IS NOT NULL AND ssn = $2)`,
            [record.legacy_id, record.ssn]
          );

          if (existing.rows.length > 0) {
            // TODO: should we update existing records? For now just skip.
            // Product wants "upsert" behavior but we need to figure out
            // conflict resolution rules first. What if the name changed?
            // Is it a correction or a different person? Can't automate this.
            result.skipped++;
            continue;
          }

          const id = uuidv4();
          await client.query(
            `INSERT INTO patients (
              id, legacy_id, first_name, last_name, middle_name,
              date_of_birth, ssn, gender, phone, email,
              address_line1, address_line2, city, state, zip_code,
              insurance_id, insurer_name, primary_provider_npi,
              status, source_system, migrated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW()
            )`,
            [
              id, record.legacy_id, record.first_name, record.last_name,
              record.middle_name || null,
              record.date_of_birth, record.ssn, record.gender,
              record.phone, record.email,
              record.address_line1 || null, record.address_line2 || null,
              record.city || null, record.state || null, record.zip_code || null,
              record.insurance_id || null, record.insurer_name || null,
              record.primary_provider_npi || null,
              record.status, this.options.source,
            ]
          );

          result.inserted++;
        } catch (err: any) {
          result.errors++;
          result.errorDetails.push({
            line: lineNum,
            message: `DB insert failed: ${err.message}`,
            data: record,
          });
          // don't rollback the whole batch for one bad record
          // just log it and continue
        }
      }

      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      // if the whole batch failed, mark all as errors
      result.errors = records.length;
      result.inserted = 0;
      result.errorDetails.push({
        line: records[0]?._lineNum,
        message: `Batch failed: ${err.message}`,
      });
    } finally {
      client.release();
    }

    return result;
  }

  private logError(detail: { line: number; message: string; data?: any }) {
    try {
      appendFileSync(
        this.errorLogPath,
        `[Line ${detail.line}] ${detail.message}\n${
          detail.data ? JSON.stringify(detail.data, null, 2) + '\n' : ''
        }\n`
      );
    } catch {
      // if we can't write the error log, well...
    }
  }
}
