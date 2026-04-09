/**
 * Sync Provider Data from NPPES (NPI Registry)
 * ==============================================
 *
 * Author: Marcus Rodriguez (mrodriguez@meridianhealth.io)
 * Created: 2024-01-20
 * Last Modified: 2025-11-05 by mrodriguez
 *
 * Syncs provider data from the CMS National Plan and Provider Enumeration
 * System (NPPES). This ensures our provider directory stays current with
 * NPI deactivations, address changes, and new registrations.
 *
 * Runs nightly via cron:
 *   30 3 * * * npx tsx /opt/meridian/scripts/etl/sync-providers-from-nppes.ts >> /var/log/meridian/nppes-sync.log 2>&1
 *
 * The NPPES API (https://npiregistry.cms.hhs.gov/api/) has a rate limit
 * of ~2 requests/second. We respect that with a delay between requests.
 * For bulk updates, we download the monthly data dissemination file instead.
 *
 * NOTE(mrodriguez 2025-11-05): CMS changed the API response format slightly
 * in October 2025. The taxonomy codes are now nested differently. Updated
 * the parser to handle both formats.
 */

import { Pool } from 'pg';
import https from 'https';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// NPPES API base URL
const NPPES_API_BASE = 'https://npiregistry.cms.hhs.gov/api';
const API_VERSION = '2.1';

// Rate limiting - be nice to the government servers
const REQUEST_DELAY_MS = 600;  // ~1.6 requests/sec, well under the limit
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// We sync providers in our system that were updated in the last N days
// from NPPES, plus any new providers
const LOOKBACK_DAYS = parseInt(process.env.NPPES_LOOKBACK_DAYS || '7');

interface NPPESResult {
  number: number;  // NPI
  enumeration_type: string;
  basic: {
    first_name: string;
    last_name: string;
    middle_name?: string;
    credential: string;
    sole_proprietor: string;
    gender: string;
    enumeration_date: string;
    last_updated: string;
    deactivation_date?: string;
    reactivation_date?: string;
    status: string;
  };
  addresses: Array<{
    address_purpose: string;
    address_1: string;
    address_2?: string;
    city: string;
    state: string;
    postal_code: string;
    telephone_number: string;
    fax_number?: string;
  }>;
  taxonomies: Array<{
    code: string;
    desc: string;
    primary: boolean;
    state: string;
    license: string;
  }>;
  // New format (Oct 2025+)
  taxonomy_groups?: Array<{
    taxonomy_group: string;
  }>;
}

interface NPPESResponse {
  result_count: number;
  results: NPPESResult[];
}

// -- API Client --------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchNPPES(npi: string, retryCount = 0): Promise<NPPESResult | null> {
  const url = `${NPPES_API_BASE}/?version=${API_VERSION}&number=${npi}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed: NPPESResponse = JSON.parse(data);

          if (parsed.result_count === 0) {
            resolve(null);
            return;
          }

          resolve(parsed.results[0]);
        } catch (err) {
          // Sometimes the API returns HTML error pages instead of JSON
          if (retryCount < MAX_RETRIES) {
            console.warn(`  Retrying NPI ${npi} after parse error (attempt ${retryCount + 1})`);
            sleep(RETRY_DELAY_MS).then(() => {
              fetchNPPES(npi, retryCount + 1).then(resolve).catch(reject);
            });
          } else {
            reject(new Error(`Failed to parse NPPES response for NPI ${npi}: ${(err as Error).message}`));
          }
        }
      });
    }).on('error', (err) => {
      if (retryCount < MAX_RETRIES) {
        console.warn(`  Retrying NPI ${npi} after network error (attempt ${retryCount + 1})`);
        sleep(RETRY_DELAY_MS).then(() => {
          fetchNPPES(npi, retryCount + 1).then(resolve).catch(reject);
        });
      } else {
        reject(err);
      }
    });
  });
}

async function searchNPPESByState(state: string, taxonomyCode?: string): Promise<NPPESResult[]> {
  // Used for finding new providers in our service area
  // This is paginated and can return up to 200 results per call
  const allResults: NPPESResult[] = [];
  let skip = 0;
  const limit = 200;  // max allowed by API

  while (true) {
    let url = `${NPPES_API_BASE}/?version=${API_VERSION}&state=${state}&limit=${limit}&skip=${skip}&enumeration_type=NPI-1`;
    if (taxonomyCode) {
      url += `&taxonomy_description=${encodeURIComponent(taxonomyCode)}`;
    }

    const response = await new Promise<NPPESResponse>((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }).on('error', reject);
    });

    if (response.result_count === 0 || response.results.length === 0) break;

    allResults.push(...response.results);
    skip += limit;

    await sleep(REQUEST_DELAY_MS);

    // Safety: don't pull more than 10k providers in one go
    if (allResults.length >= 10000) {
      console.warn('  Hit 10k result limit, stopping pagination');
      break;
    }
  }

  return allResults;
}

// -- Sync Logic --------------------------------------------------------------

function extractPrimaryTaxonomy(result: NPPESResult): { code: string; description: string; state: string; license: string } | null {
  // Handle both old and new NPPES format
  if (result.taxonomies && result.taxonomies.length > 0) {
    const primary = result.taxonomies.find(t => t.primary) || result.taxonomies[0];
    return {
      code: primary.code,
      description: primary.desc,
      state: primary.state,
      license: primary.license,
    };
  }
  return null;
}

function extractPracticeAddress(result: NPPESResult): {
  address1: string; address2: string; city: string; state: string; zip: string; phone: string; fax: string;
} | null {
  // NPPES has "LOCATION" (practice) and "MAILING" addresses
  const practice = result.addresses.find(a => a.address_purpose === 'LOCATION')
    || result.addresses[0];

  if (!practice) return null;

  return {
    address1: practice.address_1,
    address2: practice.address_2 || '',
    city: practice.city,
    state: practice.state,
    zip: practice.postal_code?.substring(0, 5) || '',  // NPPES returns 9-digit zip
    phone: practice.telephone_number,
    fax: practice.fax_number || '',
  };
}

async function syncProvider(npi: string): Promise<'updated' | 'deactivated' | 'no_change' | 'not_found' | 'error'> {
  try {
    const result = await fetchNPPES(npi);

    if (!result) {
      return 'not_found';
    }

    const taxonomy = extractPrimaryTaxonomy(result);
    const address = extractPracticeAddress(result);

    // Check if provider is deactivated
    if (result.basic.deactivation_date && !result.basic.reactivation_date) {
      await pool.query(`
        UPDATE providers
        SET is_active = false,
            deactivation_date = $1,
            deactivation_source = 'NPPES',
            updated_at = NOW()
        WHERE npi = $2
          AND is_active = true
      `, [result.basic.deactivation_date, npi]);

      return 'deactivated';
    }

    // Update provider info
    const updateResult = await pool.query(`
      UPDATE providers
      SET
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        credential = COALESCE($3, credential),
        specialty = COALESCE($4, specialty),
        license_number = COALESCE($5, license_number),
        license_state = COALESCE($6, license_state),
        practice_address_line1 = COALESCE($7, practice_address_line1),
        practice_address_line2 = $8,
        practice_city = COALESCE($9, practice_city),
        practice_state = COALESCE($10, practice_state),
        practice_zip = COALESCE($11, practice_zip),
        practice_phone = COALESCE($12, practice_phone),
        practice_fax = $13,
        nppes_last_updated = $14,
        nppes_last_synced = NOW(),
        updated_at = NOW()
      WHERE npi = $15
    `, [
      result.basic.first_name,
      result.basic.last_name,
      result.basic.credential,
      taxonomy?.description || null,
      taxonomy?.license || null,
      taxonomy?.state || null,
      address?.address1 || null,
      address?.address2 || null,
      address?.city || null,
      address?.state || null,
      address?.zip || null,
      address?.phone || null,
      address?.fax || null,
      result.basic.last_updated,
      npi,
    ]);

    return updateResult.rowCount && updateResult.rowCount > 0 ? 'updated' : 'no_change';

  } catch (err) {
    console.error(`  Error syncing NPI ${npi}: ${(err as Error).message}`);
    return 'error';
  }
}

async function main(): Promise<void> {
  console.log('=== NPPES Provider Sync ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Lookback: ${LOOKBACK_DAYS} days`);
  console.log('');

  // Get all NPIs in our system that need syncing
  const providers = await pool.query(`
    SELECT npi, first_name, last_name, nppes_last_synced
    FROM providers
    WHERE npi IS NOT NULL
      AND is_active = true
      AND (
        nppes_last_synced IS NULL
        OR nppes_last_synced < NOW() - INTERVAL '${LOOKBACK_DAYS} days'
      )
    ORDER BY nppes_last_synced ASC NULLS FIRST
  `);

  console.log(`Found ${providers.rows.length} providers to sync`);
  console.log('');

  const stats = { updated: 0, deactivated: 0, no_change: 0, not_found: 0, error: 0 };
  const startTime = Date.now();

  for (let i = 0; i < providers.rows.length; i++) {
    const provider = providers.rows[i];
    const result = await syncProvider(provider.npi);
    stats[result]++;

    if (result === 'deactivated') {
      console.log(`  DEACTIVATED: ${provider.npi} (${provider.first_name} ${provider.last_name})`);
    }

    if ((i + 1) % 100 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const remaining = Math.round(((providers.rows.length - i - 1) * REQUEST_DELAY_MS) / 1000);
      console.log(`  Progress: ${i + 1}/${providers.rows.length} (${elapsed}s elapsed, ~${remaining}s remaining)`);
    }

    // Rate limiting
    await sleep(REQUEST_DELAY_MS);
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log('');
  console.log('=== Sync Complete ===');
  console.log(`  Total providers:   ${providers.rows.length}`);
  console.log(`  Updated:           ${stats.updated}`);
  console.log(`  Deactivated:       ${stats.deactivated}`);
  console.log(`  No change:         ${stats.no_change}`);
  console.log(`  Not found in NPPES: ${stats.not_found}`);
  console.log(`  Errors:            ${stats.error}`);
  console.log(`  Duration:          ${totalTime} minutes`);

  if (stats.deactivated > 0) {
    console.log('');
    console.log('WARNING: Some providers were deactivated. Review and notify affected patients.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
