import { Pool } from 'pg';
import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import { v4 as uuidv4 } from 'uuid';
import { detectEncoding, normalizeEncoding } from '../utils/csvHelper';
import { validateNPI } from '../utils/dataValidator';

interface MigratorOptions {
  dryRun: boolean;
}

interface MigrationResult {
  totalRows: number;
  inserted: number;
  updated: number;
  errors: number;
}

const PROVIDER_FIELD_MAP: Record<string, string> = {
  'NPI': 'npi',
  'PROV_NPI': 'npi',
  'PROVIDER_NPI': 'npi',
  'FIRST_NAME': 'first_name',
  'PROV_FIRST': 'first_name',
  'LAST_NAME': 'last_name',
  'PROV_LAST': 'last_name',
  'MIDDLE_NAME': 'middle_name',
  'CREDENTIAL': 'credential',
  'CREDENTIALS': 'credential',
  'SUFFIX': 'credential', // some exports put MD, DO here
  'SPECIALTY': 'specialty',
  'TAXONOMY': 'taxonomy_code',
  'TAXONOMY_CODE': 'taxonomy_code',
  'ORG_NAME': 'organization_name',
  'PRACTICE_NAME': 'organization_name',
  'GROUP_NAME': 'organization_name',
  'ADDRESS': 'address_line1',
  'ADDRESS_1': 'address_line1',
  'ADDRESS_2': 'address_line2',
  'CITY': 'city',
  'STATE': 'state',
  'ZIP': 'zip_code',
  'PHONE': 'phone',
  'FAX': 'fax',
  'EMAIL': 'email',
  'ACCEPTING_PATIENTS': 'accepting_patients',
  'ACTIVE': 'is_active',
  'STATUS': 'is_active',
  'DEA_NUMBER': 'dea_number', // Drug Enforcement Administration
  'LICENSE_NUMBER': 'license_number',
  'LICENSE_STATE': 'license_state',
};

export class ProviderMigrator {
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
      updated: 0,
      errors: 0,
    };

    const encoding = await detectEncoding(filePath);

    const parser = createReadStream(filePath)
      .pipe(normalizeEncoding(encoding))
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_quotes: true,
      }));

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      for await (const record of parser) {
        result.totalRows++;

        const normalized = this.normalizeFields(record);
        const cleaned = this.cleanProviderData(normalized);

        // NPI is required - can't do much without it
        if (!cleaned.npi) {
          result.errors++;
          console.warn(`Row ${result.totalRows}: Missing NPI, skipping`);
          continue;
        }

        // Validate NPI format
        if (!validateNPI(cleaned.npi)) {
          result.errors++;
          console.warn(`Row ${result.totalRows}: Invalid NPI format: ${cleaned.npi}`);
          continue;
        }

        if (this.options.dryRun) {
          result.inserted++; // count what would have been inserted
          continue;
        }

        try {
          // Providers use upsert - if NPI exists, update the record
          // This is different from patients where we skip duplicates
          const existing = await client.query(
            'SELECT id FROM providers WHERE npi = $1',
            [cleaned.npi]
          );

          if (existing.rows.length > 0) {
            await client.query(
              `UPDATE providers SET
                first_name = COALESCE($2, first_name),
                last_name = COALESCE($3, last_name),
                middle_name = COALESCE($4, middle_name),
                credential = COALESCE($5, credential),
                specialty = COALESCE($6, specialty),
                taxonomy_code = COALESCE($7, taxonomy_code),
                organization_name = COALESCE($8, organization_name),
                address_line1 = COALESCE($9, address_line1),
                address_line2 = COALESCE($10, address_line2),
                city = COALESCE($11, city),
                state = COALESCE($12, state),
                zip_code = COALESCE($13, zip_code),
                phone = COALESCE($14, phone),
                fax = COALESCE($15, fax),
                email = COALESCE($16, email),
                accepting_patients = COALESCE($17, accepting_patients),
                is_active = COALESCE($18, is_active),
                updated_at = NOW()
              WHERE npi = $1`,
              [
                cleaned.npi, cleaned.first_name, cleaned.last_name,
                cleaned.middle_name, cleaned.credential, cleaned.specialty,
                cleaned.taxonomy_code, cleaned.organization_name,
                cleaned.address_line1, cleaned.address_line2,
                cleaned.city, cleaned.state, cleaned.zip_code,
                cleaned.phone, cleaned.fax, cleaned.email,
                cleaned.accepting_patients, cleaned.is_active,
              ]
            );
            result.updated++;
          } else {
            const id = uuidv4();
            await client.query(
              `INSERT INTO providers (
                id, npi, first_name, last_name, middle_name,
                credential, specialty, taxonomy_code, organization_name,
                address_line1, address_line2, city, state, zip_code,
                phone, fax, email, accepting_patients, is_active,
                dea_number, license_number, license_state,
                created_at, updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19,
                $20, $21, NOW(), NOW()
              )`,
              [
                id, cleaned.npi, cleaned.first_name, cleaned.last_name,
                cleaned.middle_name, cleaned.credential, cleaned.specialty,
                cleaned.taxonomy_code, cleaned.organization_name,
                cleaned.address_line1, cleaned.address_line2,
                cleaned.city, cleaned.state, cleaned.zip_code,
                cleaned.phone, cleaned.fax, cleaned.email,
                cleaned.accepting_patients, cleaned.is_active,
                cleaned.dea_number, cleaned.license_number,
              ]
            );
            result.inserted++;
          }
        } catch (err: any) {
          result.errors++;
          console.error(`Row ${result.totalRows}: ${err.message}`);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return result;
  }

  private normalizeFields(record: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const mappedKey = PROVIDER_FIELD_MAP[key.toUpperCase().trim()];
      if (mappedKey && !(mappedKey in normalized)) {
        normalized[mappedKey] = value;
      }
    }
    return normalized;
  }

  private cleanProviderData(data: Record<string, string>): Record<string, any> {
    const cleaned: Record<string, any> = { ...data };

    // NPI should be 10 digits
    if (cleaned.npi) {
      cleaned.npi = cleaned.npi.replace(/\D/g, '');
    }

    // Fix ALL CAPS names
    for (const field of ['first_name', 'last_name', 'middle_name']) {
      if (cleaned[field]) {
        const val = cleaned[field].trim();
        if (val === val.toUpperCase() && val.length > 1) {
          cleaned[field] = val.charAt(0) + val.slice(1).toLowerCase();
        } else {
          cleaned[field] = val;
        }
      }
    }

    // Credential cleanup - normalize various formats
    if (cleaned.credential) {
      let cred = cleaned.credential.toUpperCase().trim();
      cred = cred.replace(/\./g, ''); // "M.D." -> "MD"
      cleaned.credential = cred;
    }

    // Boolean fields
    if (cleaned.accepting_patients) {
      const val = cleaned.accepting_patients.toUpperCase().trim();
      cleaned.accepting_patients = val === 'Y' || val === 'YES' || val === 'TRUE' || val === '1';
    } else {
      cleaned.accepting_patients = true; // default to yes
    }

    if (cleaned.is_active) {
      const val = cleaned.is_active.toUpperCase().trim();
      cleaned.is_active = val === 'Y' || val === 'YES' || val === 'TRUE' || val === '1'
        || val === 'A' || val === 'ACTIVE';
    } else {
      cleaned.is_active = true;
    }

    // Phone cleanup
    for (const field of ['phone', 'fax']) {
      if (cleaned[field]) {
        cleaned[field] = cleaned[field].replace(/\D/g, '');
        if (cleaned[field].length !== 10) {
          cleaned[field] = null;
        }
      }
    }

    // ZIP
    if (cleaned.zip_code) {
      cleaned.zip_code = cleaned.zip_code.split('-')[0].substring(0, 5);
    }

    return cleaned;
  }
}
