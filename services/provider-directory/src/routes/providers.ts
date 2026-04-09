import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { providerSearch } from '../services/providerSearch';
import { validateNPI } from '../services/npiValidator';
import { Provider, CreateProviderInput, ProviderStatus } from '../models/Provider';

const router = Router();

// Helper to get pool and logger from global (yes this is gross)
const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * GET /api/v1/providers/search
 * Full-text search with geo, specialty filters, etc.
 */
router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      q,          // search query
      specialty,
      taxonomy,
      lat,
      lng,
      radius,     // in miles, default 25
      accepting,  // accepting new patients
      language,
      gender,
      network_id,
      telehealth,
      page = '1',
      page_size = '20',
      sort,       // relevance, distance, rating, name
    } = req.query;

    // validate page_size isn't absurd
    const parsedPageSize = Math.min(parseInt(page_size as string) || 20, 100);
    const parsedPage = Math.max(parseInt(page as string) || 1, 1);

    const searchParams = {
      query: q as string,
      specialty: specialty as string,
      taxonomy_code: taxonomy as string,
      location: lat && lng ? {
        lat: parseFloat(lat as string),
        lng: parseFloat(lng as string),
        radius_miles: parseFloat(radius as string) || 25,
      } : undefined,
      accepting_new_patients: accepting === 'true' ? true : accepting === 'false' ? false : undefined,
      language: language as string,
      gender: gender as string,
      network_id: network_id as string,
      telehealth_available: telehealth === 'true' ? true : undefined,
      page: parsedPage,
      page_size: parsedPageSize,
      sort: (sort as string) || 'relevance',
    };

    const results = await providerSearch(searchParams);

    res.json(results);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/providers/:id
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();

    const { id } = req.params;

    // try to find by UUID first, then by NPI
    let query: string;
    let params: string[];

    // crude check if it looks like a UUID
    if (id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      query = 'SELECT * FROM providers WHERE id = $1 AND deleted_at IS NULL';
      params = [id];
    } else if (/^\d{10}$/.test(id)) {
      // looks like an NPI
      query = 'SELECT * FROM providers WHERE npi = $1 AND deleted_at IS NULL';
      params = [id];
    } else {
      return res.status(400).json({ error: 'Invalid provider ID format' });
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const provider = result.rows[0];

    // Fetch related data
    // TODO: this is N+1 query pattern - should be a single JOIN
    const [addresses, specialties, networks] = await Promise.all([
      pool.query('SELECT * FROM provider_addresses WHERE provider_id = $1 ORDER BY is_primary DESC', [provider.id]),
      pool.query('SELECT * FROM provider_specialties WHERE provider_id = $1 ORDER BY is_primary DESC', [provider.id]),
      pool.query(`
        SELECT na.*, n.name as network_name
        FROM provider_network_affiliations na
        JOIN networks n ON n.id = na.network_id
        WHERE na.provider_id = $1
          AND (na.termination_date IS NULL OR na.termination_date > NOW())
      `, [provider.id]),
    ]);

    provider.addresses = addresses.rows;
    provider.specialties = specialties.rows;
    provider.network_affiliations = networks.rows;

    res.json({ data: provider });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/providers
 * Create a new provider
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const input: CreateProviderInput = req.body;

    // Validate NPI
    if (!input.npi || !validateNPI(input.npi)) {
      return res.status(400).json({
        error: 'Invalid NPI',
        message: 'NPI must be a valid 10-digit number that passes the Luhn check',
      });
    }

    // Check for duplicate NPI
    const existing = await pool.query(
      'SELECT id FROM providers WHERE npi = $1 AND deleted_at IS NULL',
      [input.npi]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Duplicate NPI',
        message: `Provider with NPI ${input.npi} already exists`,
        existing_id: existing.rows[0].id,
      });
    }

    // Build display name
    const displayName = input.organization_name
      || `${input.name_prefix || ''} ${input.first_name || ''} ${input.last_name || ''}${input.credentials?.length ? ', ' + input.credentials.join(', ') : ''}`.trim();

    const id = uuidv4();
    const now = new Date();

    // Start a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert provider
      await client.query(`
        INSERT INTO providers (
          id, npi, npi_type, provider_type, status,
          first_name, middle_name, last_name, suffix, name_prefix,
          organization_name, display_name, credentials, gender,
          accepting_new_patients, telehealth_available, languages,
          phone, email, website, bio,
          group_practice_id, group_practice_name,
          source_system, source_id,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23,
          $24, $25,
          $26, $27
        )
      `, [
        id, input.npi, input.npi_type || 1, input.provider_type || 'individual',
        input.status || ProviderStatus.PENDING_VERIFICATION,
        input.first_name, input.middle_name, input.last_name, input.suffix, input.name_prefix,
        input.organization_name, displayName, input.credentials || [],
        input.gender,
        input.accepting_new_patients ?? true, input.telehealth_available ?? false,
        input.languages || ['en'],
        input.phone, input.email, input.website, input.bio,
        input.group_practice_id, input.group_practice_name,
        input.source_system, input.source_id,
        now, now,
      ]);

      // Insert addresses
      if (input.addresses?.length) {
        for (const addr of input.addresses) {
          await client.query(`
            INSERT INTO provider_addresses (
              id, provider_id, address_line_1, address_line_2,
              city, state, zip_code, zip_plus_4, county, country,
              address_type, latitude, longitude, geocoded,
              phone, fax, office_hours, is_primary,
              is_accepting_patients_at_location
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          `, [
            uuidv4(), id, addr.address_line_1, addr.address_line_2,
            addr.city, addr.state, addr.zip_code, addr.zip_plus_4,
            addr.county, addr.country || 'US',
            addr.address_type || 'practice', addr.latitude, addr.longitude,
            addr.geocoded || false,
            addr.phone, addr.fax, JSON.stringify(addr.office_hours || {}),
            addr.is_primary ?? false,
            addr.is_accepting_patients_at_location,
          ]);
        }
      }

      // Insert specialties
      if (input.specialties?.length) {
        for (const spec of input.specialties) {
          await client.query(`
            INSERT INTO provider_specialties (
              id, provider_id, taxonomy_code, specialty_name,
              is_primary, board_certified, certification_date,
              classification, specialization
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [
            uuidv4(), id, spec.taxonomy_code, spec.specialty_name,
            spec.is_primary ?? false, spec.board_certified ?? false,
            spec.certification_date, spec.classification, spec.specialization,
          ]);
        }
      }

      await client.query('COMMIT');

      // Index in Elasticsearch asynchronously
      // Don't await - we don't want to block the response if ES is slow
      indexProviderInES(id).catch(err => {
        logger.error('Failed to index provider in ES', { providerId: id, error: err.message });
      });

      logger.info('Provider created', { providerId: id, npi: input.npi });

      res.status(201).json({
        data: { id, npi: input.npi, display_name: displayName },
        message: 'Provider created successfully',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/providers/:id
 */
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const updates = req.body;

    // Don't allow NPI changes through this endpoint
    if (updates.npi) {
      return res.status(400).json({
        error: 'Cannot change NPI',
        message: 'NPI changes must go through the provider merge workflow',
      });
    }

    const existing = await pool.query(
      'SELECT * FROM providers WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    // Build SET clause dynamically
    // Yeah I know this is ugly but it works and we have tests
    const allowedFields = [
      'first_name', 'middle_name', 'last_name', 'suffix', 'name_prefix',
      'organization_name', 'display_name', 'credentials', 'gender',
      'accepting_new_patients', 'telehealth_available', 'languages',
      'phone', 'email', 'website', 'bio', 'status',
      'group_practice_id', 'group_practice_name',
    ];

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push(`updated_at = $${paramIndex}`);
    values.push(new Date());
    paramIndex++;

    values.push(id);

    await pool.query(
      `UPDATE providers SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    // Re-index in ES
    indexProviderInES(id).catch(err => {
      getLogger().error('Failed to re-index provider', { providerId: id, error: err.message });
    });

    res.json({ message: 'Provider updated', id });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/providers/:id
 * Soft delete
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      'UPDATE providers SET deleted_at = NOW(), status = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL RETURNING id',
      [ProviderStatus.INACTIVE, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    // Remove from ES index
    const esClient = (global as any).__esClient;
    try {
      await esClient.delete({ index: 'providers', id });
    } catch (esErr: any) {
      // ES might not have this doc, that's fine
      if (esErr.meta?.statusCode !== 404) {
        getLogger().error('Failed to delete from ES index', { providerId: id });
      }
    }

    res.json({ message: 'Provider deleted', id });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/providers/:id/verify-npi
 * Verify NPI against the NPPES registry
 */
router.get('/:id/verify-npi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      'SELECT npi, first_name, last_name, organization_name FROM providers WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const provider = result.rows[0];

    // TODO: actually call the NPPES API at https://npiregistry.cms.hhs.gov/api/
    // For now just validate the checksum
    const isValid = validateNPI(provider.npi);

    // Update last verified timestamp
    await pool.query(
      'UPDATE providers SET last_verified_at = NOW(), npi_registry_synced_at = NOW() WHERE id = $1',
      [id]
    );

    res.json({
      npi: provider.npi,
      valid: isValid,
      verified_at: new Date().toISOString(),
      // registry_match: null, // TODO: add NPPES lookup result
    });
  } catch (err) {
    next(err);
  }
});

// Helper to index a provider in Elasticsearch
async function indexProviderInES(providerId: string): Promise<void> {
  const pool = getPool();
  const esClient = (global as any).__esClient;

  const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [providerId]);
  if (providerResult.rows.length === 0) return;

  const provider = providerResult.rows[0];

  const addressResult = await pool.query(
    'SELECT * FROM provider_addresses WHERE provider_id = $1 AND is_primary = true LIMIT 1',
    [providerId]
  );

  const primaryAddress = addressResult.rows[0];

  const specialtyResult = await pool.query(
    'SELECT * FROM provider_specialties WHERE provider_id = $1',
    [providerId]
  );

  const doc: any = {
    npi: provider.npi,
    first_name: provider.first_name,
    last_name: provider.last_name,
    display_name: provider.display_name,
    organization_name: provider.organization_name,
    specialty: specialtyResult.rows.map((s: any) => s.specialty_name),
    taxonomy_code: specialtyResult.rows.map((s: any) => s.taxonomy_code),
    accepting_new_patients: provider.accepting_new_patients,
    telehealth_available: provider.telehealth_available,
    languages: provider.languages,
    gender: provider.gender,
    credentials: provider.credentials,
    rating: provider.rating,
    bio: provider.bio,
    network_ids: [], // TODO: pull from network affiliations
    status: provider.status,
  };

  if (primaryAddress?.latitude && primaryAddress?.longitude) {
    doc.location = {
      lat: primaryAddress.latitude,
      lon: primaryAddress.longitude,
    };
  }

  await esClient.index({
    index: 'providers',
    id: providerId,
    body: doc,
    refresh: 'wait_for', // so subsequent searches can find it immediately
  });
}

export default router;
