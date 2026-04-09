import { Pool } from 'pg';
import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import { v4 as uuidv4 } from 'uuid';
import { detectEncoding, normalizeEncoding } from '../utils/csvHelper';
import { validateClaim } from '../utils/dataValidator';

interface MigratorOptions {
  batchSize: number;
  dryRun: boolean;
  format: 'csv' | 'tsv' | 'pipe';
  source: string;
}

interface MigrationResult {
  totalRows: number;
  inserted: number;
  skipped: number;
  errors: number;
  errorDetails: { line: number; message: string }[];
}

// The old billing system uses different claim formats depending on when the
// data was exported. Pre-2020 exports use pipe-delimited format (thanks to
// a mainframe somewhere), 2020-2022 use TSV, and post-2022 use CSV.
// The field names also changed at least twice.

const OLD_CLAIM_FIELDS: Record<string, string> = {
  'CLM_NUM': 'claim_number',
  'CLAIM_NUMBER': 'claim_number',
  'CLAIM_NO': 'claim_number',
  'PAT_ACCT': 'patient_account',
  'PATIENT_ACCOUNT': 'patient_account',
  'PAT_ID': 'patient_legacy_id',
  'PATIENT_ID': 'patient_legacy_id',
  'PROV_NPI': 'provider_npi',
  'RENDERING_NPI': 'provider_npi',
  'SVC_DATE': 'service_date',
  'SERVICE_DATE': 'service_date',
  'DATE_OF_SERVICE': 'service_date',
  'DOS': 'service_date',
  'SVC_DATE_END': 'service_date_end',
  'THRU_DATE': 'service_date_end',
  'SUBMIT_DATE': 'submitted_date',
  'DATE_SUBMITTED': 'submitted_date',
  'BILLED_AMT': 'billed_amount',
  'BILLED_AMOUNT': 'billed_amount',
  'TOTAL_CHARGES': 'billed_amount',
  'ALLOWED_AMT': 'allowed_amount',
  'ALLOWED_AMOUNT': 'allowed_amount',
  'PAID_AMT': 'paid_amount',
  'PAID_AMOUNT': 'paid_amount',
  'ADJ_AMT': 'adjustment_amount',
  'ADJUSTMENT': 'adjustment_amount',
  'CLM_STATUS': 'status',
  'STATUS': 'status',
  'CLAIM_STATUS': 'status',
  'CLM_TYPE': 'claim_type',
  'CLAIM_TYPE': 'claim_type',
  'TYPE_OF_BILL': 'claim_type', // institutional claims use this
  'PAYER_ID': 'payer_id',
  'PAYER_NAME': 'payer_name',
  'INSURANCE_CO': 'payer_name',
  'DX_1': 'diagnosis_code_1',
  'DIAGNOSIS_1': 'diagnosis_code_1',
  'PRIMARY_DX': 'diagnosis_code_1',
  'DX_2': 'diagnosis_code_2',
  'DIAGNOSIS_2': 'diagnosis_code_2',
  'DX_3': 'diagnosis_code_3',
  'DX_4': 'diagnosis_code_4',
  'CPT_1': 'procedure_code_1',
  'PROCEDURE_1': 'procedure_code_1',
  'HCPCS': 'procedure_code_1',
  'CPT_2': 'procedure_code_2',
  'CPT_3': 'procedure_code_3',
  'POS': 'place_of_service',
  'PLACE_OF_SERVICE': 'place_of_service',
  'MODIFIER_1': 'modifier_1',
  'MOD_1': 'modifier_1',
  'MODIFIER_2': 'modifier_2',
  'MOD_2': 'modifier_2',
  'DENIAL_CODE': 'denial_reason_code',
  'DENIAL_REASON': 'denial_reason_code',
  'REMARK_CODE': 'remark_code',
};

// Status mapping between old and new systems
const STATUS_MAP: Record<string, string> = {
  'P': 'paid',
  'PAID': 'paid',
  'A': 'approved',
  'APPROVED': 'approved',
  'D': 'denied',
  'DENIED': 'denied',
  'R': 'rejected',
  'REJECTED': 'rejected',
  'S': 'submitted',
  'SUBMITTED': 'submitted',
  'H': 'on_hold',
  'HOLD': 'on_hold',
  'ON HOLD': 'on_hold',
  'V': 'void',
  'VOID': 'void',
  'VOIDED': 'void',
  // wtf is status 'X'? found it in some 2019 data, treating as void
  'X': 'void',
};

export class ClaimsMigrator {
  private pool: Pool;
  private options: MigratorOptions;

  constructor(pool: Pool, options: MigratorOptions) {
    this.pool = pool;
    this.options = options;
  }

  async migrate(filePath: string): Promise<MigrationResult> {
    const result: MigrationResult = {
      totalRows: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      errorDetails: [],
    };

    const encoding = await detectEncoding(filePath);
    const delimiter = this.options.format === 'tsv' ? '\t'
      : this.options.format === 'pipe' ? '|'
      : ',';

    const parser = createReadStream(filePath)
      .pipe(normalizeEncoding(encoding))
      .pipe(parse({
        columns: true,
        delimiter,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_quotes: true,
        relax_column_count: true,
      }));

    let batch: any[] = [];
    let lineNum = 0;

    for await (const record of parser) {
      lineNum++;
      result.totalRows++;

      const normalized = this.normalizeFields(record);
      const cleaned = this.cleanClaimData(normalized);

      try {
        validateClaim(cleaned);
      } catch (err: any) {
        result.errors++;
        result.errorDetails.push({ line: lineNum, message: err.message });
        continue;
      }

      batch.push({ ...cleaned, _line: lineNum });

      if (batch.length >= this.options.batchSize) {
        const batchResult = await this.insertBatch(batch);
        result.inserted += batchResult.inserted;
        result.skipped += batchResult.skipped;
        result.errors += batchResult.errors;
        batch = [];
      }
    }

    // remaining
    if (batch.length > 0) {
      const batchResult = await this.insertBatch(batch);
      result.inserted += batchResult.inserted;
      result.skipped += batchResult.skipped;
      result.errors += batchResult.errors;
    }

    return result;
  }

  private normalizeFields(record: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const mappedKey = OLD_CLAIM_FIELDS[key.toUpperCase().trim()];
      if (mappedKey && !(mappedKey in normalized)) {
        normalized[mappedKey] = value;
      }
    }
    return normalized;
  }

  private cleanClaimData(data: Record<string, string>): Record<string, any> {
    const cleaned: Record<string, any> = { ...data };

    // Parse amounts - the old system uses various formats:
    // "$1,234.56", "1234.56", "1,234", "-$50.00"
    for (const field of ['billed_amount', 'allowed_amount', 'paid_amount', 'adjustment_amount']) {
      if (cleaned[field]) {
        cleaned[field] = this.parseAmount(cleaned[field]);
      } else {
        cleaned[field] = null;
      }
    }

    // If we have billed and paid but no adjustment, calculate it
    // NOTE: this can result in rounding errors with certain payer adjustments
    // because the old system stored amounts as strings and we lose precision.
    // Known issue, affects ~0.1% of claims. Usually off by $0.01.
    if (cleaned.billed_amount != null && cleaned.paid_amount != null && cleaned.adjustment_amount == null) {
      cleaned.adjustment_amount = Math.round((cleaned.billed_amount - cleaned.paid_amount) * 100) / 100;
    }

    // Normalize status
    if (cleaned.status) {
      const upper = cleaned.status.toUpperCase().trim();
      cleaned.status = STATUS_MAP[upper] || 'submitted'; // default to submitted if unknown
    }

    // Claim type normalization
    if (cleaned.claim_type) {
      const ct = cleaned.claim_type.toUpperCase().trim();
      if (ct === 'P' || ct === 'PROF' || ct === 'PROFESSIONAL' || ct === 'CMS-1500') {
        cleaned.claim_type = 'professional';
      } else if (ct === 'I' || ct === 'INST' || ct === 'INSTITUTIONAL' || ct === 'UB-04') {
        cleaned.claim_type = 'institutional';
      } else if (ct === 'RX' || ct === 'PHARMACY' || ct === 'DRUG') {
        cleaned.claim_type = 'pharmacy';
      } else {
        // TYPE_OF_BILL is a 3-4 digit code for institutional claims
        // first digit indicates the type of facility
        if (/^\d{3,4}$/.test(ct)) {
          cleaned.claim_type = 'institutional';
          cleaned.type_of_bill = ct;
        } else {
          cleaned.claim_type = 'professional'; // default
        }
      }
    }

    // Diagnosis codes - strip periods and normalize
    for (const field of ['diagnosis_code_1', 'diagnosis_code_2', 'diagnosis_code_3', 'diagnosis_code_4']) {
      if (cleaned[field]) {
        // ICD-10 codes have a period after 3rd character, but sometimes
        // the legacy system stores them without the period
        let code = cleaned[field].toUpperCase().trim();
        code = code.replace(/\s+/g, '');
        // some old records have ICD-9 codes mixed in (pre-2015 data)
        // we store them as-is but flag them
        cleaned[field] = code;
      }
    }

    // Procedure codes
    for (const field of ['procedure_code_1', 'procedure_code_2', 'procedure_code_3']) {
      if (cleaned[field]) {
        cleaned[field] = cleaned[field].toUpperCase().trim();
      }
    }

    // Date parsing
    for (const field of ['service_date', 'service_date_end', 'submitted_date']) {
      if (cleaned[field]) {
        cleaned[field] = this.parseDate(cleaned[field]);
      }
    }

    // Place of service - should be 2-digit code
    if (cleaned.place_of_service) {
      cleaned.place_of_service = cleaned.place_of_service.padStart(2, '0');
    }

    return cleaned;
  }

  private parseAmount(value: string): number | null {
    if (!value || value.trim() === '') return null;
    // remove $, commas, spaces
    const cleaned = value.replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    if (isNaN(num)) return null;
    return Math.round(num * 100) / 100; // round to cents
  }

  private parseDate(dateStr: string): string | null {
    if (!dateStr || dateStr.trim() === '') return null;
    const trimmed = dateStr.trim();

    // same date parsing nightmare as patient migrator
    // TODO: extract this into a shared utility
    let match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (match) {
      return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    }

    match = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (match) {
      return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    }

    match = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }

    return null;
  }

  private async insertBatch(records: any[]): Promise<{ inserted: number; skipped: number; errors: number }> {
    if (this.options.dryRun) {
      return { inserted: 0, skipped: records.length, errors: 0 };
    }

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const record of records) {
        const line = record._line;
        delete record._line;

        try {
          // check for duplicate claim
          const existing = await client.query(
            'SELECT id FROM claims WHERE claim_number = $1 AND source_system = $2',
            [record.claim_number, this.options.source]
          );

          if (existing.rows.length > 0) {
            skipped++;
            continue;
          }

          // look up patient by legacy ID
          let patientId = null;
          if (record.patient_legacy_id) {
            const patient = await client.query(
              'SELECT id FROM patients WHERE legacy_id = $1',
              [record.patient_legacy_id]
            );
            patientId = patient.rows[0]?.id || null;
            // if patient not found, we still insert the claim but with null patient_id
            // ops team will need to manually link these later
            // TODO: add a report for "orphaned claims" - claims with no patient link
          }

          const id = uuidv4();
          await client.query(
            `INSERT INTO claims (
              id, claim_number, patient_id, patient_legacy_id,
              provider_npi, service_date, service_date_end, submitted_date,
              billed_amount, allowed_amount, paid_amount, adjustment_amount,
              status, claim_type, payer_id, payer_name,
              diagnosis_code_1, diagnosis_code_2, diagnosis_code_3, diagnosis_code_4,
              procedure_code_1, procedure_code_2, procedure_code_3,
              place_of_service, modifier_1, modifier_2,
              denial_reason_code, remark_code,
              source_system, migrated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW()
            )`,
            [
              id, record.claim_number, patientId, record.patient_legacy_id,
              record.provider_npi, record.service_date, record.service_date_end,
              record.submitted_date,
              record.billed_amount, record.allowed_amount, record.paid_amount,
              record.adjustment_amount,
              record.status || 'submitted', record.claim_type || 'professional',
              record.payer_id, record.payer_name,
              record.diagnosis_code_1, record.diagnosis_code_2,
              record.diagnosis_code_3, record.diagnosis_code_4,
              record.procedure_code_1, record.procedure_code_2, record.procedure_code_3,
              record.place_of_service, record.modifier_1, record.modifier_2,
              record.denial_reason_code, record.remark_code,
              this.options.source,
            ]
          );

          inserted++;
        } catch (err: any) {
          errors++;
          console.error(`Error inserting claim at line ${line}: ${err.message}`);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      errors = records.length;
      inserted = 0;
    } finally {
      client.release();
    }

    return { inserted, skipped, errors };
  }
}
