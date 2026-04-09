import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import { Pool } from 'pg';
import { ProviderSearchResponse, ProviderSearchResult } from '../models/Provider';

interface SearchParams {
  query?: string;
  specialty?: string;
  taxonomy_code?: string;
  location?: {
    lat: number;
    lng: number;
    radius_miles: number;
  };
  accepting_new_patients?: boolean;
  language?: string;
  gender?: string;
  network_id?: string;
  telehealth_available?: boolean;
  page: number;
  page_size: number;
  sort: string;
}

const getESClient = (): ElasticsearchClient => (global as any).__esClient;
const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * Provider search
 *
 * Tries Elasticsearch first, falls back to postgres if ES is unavailable.
 * The ES query is built dynamically based on the search params using a
 * bool query with must/filter/should clauses.
 *
 * This got pretty complex over time as we added more search features.
 * Probably should be refactored into a query builder pattern but honestly
 * it works fine and nobody wants to touch it.
 *
 * Known issues:
 * - Geo search doesn't work well when a provider has multiple locations -
 *   we only index the primary address location. Ticket: PLAT-4890
 * - The boosting weights were tuned by hand and probably aren't optimal.
 *   We talked about A/B testing different weights but never got to it.
 * - Sort by "name" sorts by display_name which is inconsistent for orgs
 *   vs individual providers (org: "Springfield Medical Group" vs individual:
 *   "Dr. John Smith, MD")
 */
export async function providerSearch(params: SearchParams): Promise<ProviderSearchResponse> {
  const logger = getLogger();
  const startTime = Date.now();

  try {
    return await searchWithElasticsearch(params, startTime);
  } catch (err: any) {
    logger.warn('Elasticsearch search failed, falling back to postgres', {
      error: err.message,
    });
    return await searchWithPostgres(params, startTime);
  }
}

async function searchWithElasticsearch(
  params: SearchParams,
  startTime: number
): Promise<ProviderSearchResponse> {
  const esClient = getESClient();

  // Build the Elasticsearch query
  const must: any[] = [];
  const filter: any[] = [];
  const should: any[] = [];

  // Status filter - always applied
  filter.push({ term: { status: 'active' } });

  // Full-text search query
  if (params.query) {
    must.push({
      bool: {
        should: [
          // Exact NPI match (highest boost)
          {
            term: {
              npi: {
                value: params.query,
                boost: 10,
              },
            },
          },
          // Name match
          {
            multi_match: {
              query: params.query,
              fields: [
                'last_name^5',
                'first_name^3',
                'display_name^4',
                'organization_name^4',
                'bio^1',
              ],
              type: 'best_fields',
              fuzziness: 'AUTO',
              prefix_length: 2,
            },
          },
          // Specialty match (for queries like "cardiologist" or "heart doctor")
          {
            multi_match: {
              query: params.query,
              fields: ['specialty^3', 'credentials^2'],
              type: 'best_fields',
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }

  // Specialty filter
  if (params.specialty) {
    filter.push({
      term: { specialty: params.specialty },
    });
  }

  // Taxonomy code filter
  if (params.taxonomy_code) {
    filter.push({
      term: { taxonomy_code: params.taxonomy_code },
    });
  }

  // Accepting new patients
  if (params.accepting_new_patients !== undefined) {
    filter.push({
      term: { accepting_new_patients: params.accepting_new_patients },
    });
  }

  // Language filter
  if (params.language) {
    filter.push({
      term: { languages: params.language.toLowerCase() },
    });
  }

  // Gender filter
  if (params.gender) {
    filter.push({
      term: { gender: params.gender.toUpperCase() },
    });
  }

  // Network filter
  if (params.network_id) {
    filter.push({
      term: { network_ids: params.network_id },
    });
  }

  // Telehealth filter
  if (params.telehealth_available) {
    filter.push({
      term: { telehealth_available: true },
    });
  }

  // Geo-distance filter and sort
  if (params.location) {
    filter.push({
      geo_distance: {
        distance: `${params.location.radius_miles}mi`,
        location: {
          lat: params.location.lat,
          lon: params.location.lng,
        },
      },
    });

    // Boost closer providers
    should.push({
      function_score: {
        functions: [
          {
            gauss: {
              location: {
                origin: {
                  lat: params.location.lat,
                  lon: params.location.lng,
                },
                scale: '5mi',
                offset: '1mi',
                decay: 0.5,
              },
            },
          },
        ],
        score_mode: 'multiply',
        boost_mode: 'multiply',
      },
    });
  }

  // Build sort
  const sort: any[] = buildSortClause(params);

  // Build the full query
  const body: any = {
    query: {
      bool: {
        must: must.length > 0 ? must : [{ match_all: {} }],
        filter,
        should,
      },
    },
    sort,
    from: (params.page - 1) * params.page_size,
    size: params.page_size,
    highlight: {
      fields: {
        bio: { fragment_size: 150, number_of_fragments: 2 },
        display_name: {},
        specialty: {},
      },
    },
    // Include distance in response if geo search
    ...(params.location ? {
      script_fields: {
        distance_miles: {
          script: {
            source: `doc['location'].size() > 0 ?
              doc['location'].arcDistance(params.lat, params.lon) * 0.000621371 :
              null`,
            params: {
              lat: params.location.lat,
              lon: params.location.lng,
            },
          },
        },
      },
    } : {}),
  };

  const response = await esClient.search({
    index: 'providers',
    body,
  });

  const total = typeof response.hits.total === 'number'
    ? response.hits.total
    : response.hits.total?.value || 0;

  const results: ProviderSearchResult[] = response.hits.hits.map((hit: any) => ({
    provider: {
      id: hit._id,
      ...hit._source,
    },
    score: hit._score || 0,
    distance_miles: hit.fields?.distance_miles?.[0] ?? undefined,
    highlights: hit.highlight || {},
  }));

  return {
    results,
    total,
    page: params.page,
    page_size: params.page_size,
    took_ms: Date.now() - startTime,
    source: 'elasticsearch',
  };
}

/**
 * Fallback to postgres when ES is down
 * This is deliberately simpler - no fuzzy matching, no geo-distance scoring,
 * just basic LIKE queries and PostGIS distance if available.
 */
async function searchWithPostgres(
  params: SearchParams,
  startTime: number
): Promise<ProviderSearchResponse> {
  const pool = getPool();
  const logger = getLogger();

  const conditions: string[] = ['p.deleted_at IS NULL', "p.status = 'active'"];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.query) {
    conditions.push(`(
      p.display_name ILIKE $${paramIndex}
      OR p.first_name ILIKE $${paramIndex}
      OR p.last_name ILIKE $${paramIndex}
      OR p.npi = $${paramIndex + 1}
    )`);
    queryParams.push(`%${params.query}%`, params.query);
    paramIndex += 2;
  }

  if (params.specialty) {
    conditions.push(`EXISTS (
      SELECT 1 FROM provider_specialties ps
      WHERE ps.provider_id = p.id AND ps.specialty_name = $${paramIndex}
    )`);
    queryParams.push(params.specialty);
    paramIndex++;
  }

  if (params.accepting_new_patients !== undefined) {
    conditions.push(`p.accepting_new_patients = $${paramIndex}`);
    queryParams.push(params.accepting_new_patients);
    paramIndex++;
  }

  if (params.gender) {
    conditions.push(`p.gender = $${paramIndex}`);
    queryParams.push(params.gender.toUpperCase());
    paramIndex++;
  }

  if (params.telehealth_available) {
    conditions.push(`p.telehealth_available = $${paramIndex}`);
    queryParams.push(true);
    paramIndex++;
  }

  // Basic geo filter using bounding box (rough approximation)
  // We don't use PostGIS because not all environments have it installed
  // This is obviously not as accurate as ES geo_distance
  if (params.location) {
    const latDelta = params.location.radius_miles / 69.0; // rough miles per degree
    const lngDelta = params.location.radius_miles / (69.0 * Math.cos(params.location.lat * Math.PI / 180));

    conditions.push(`EXISTS (
      SELECT 1 FROM provider_addresses pa
      WHERE pa.provider_id = p.id
        AND pa.latitude BETWEEN $${paramIndex} AND $${paramIndex + 1}
        AND pa.longitude BETWEEN $${paramIndex + 2} AND $${paramIndex + 3}
    )`);
    queryParams.push(
      params.location.lat - latDelta,
      params.location.lat + latDelta,
      params.location.lng - lngDelta,
      params.location.lng + lngDelta,
    );
    paramIndex += 4;
  }

  const whereClause = conditions.join(' AND ');

  // Count
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM providers p WHERE ${whereClause}`,
    queryParams
  );
  const total = parseInt(countResult.rows[0].count);

  // Fetch results
  const offset = (params.page - 1) * params.page_size;
  queryParams.push(params.page_size, offset);

  let orderBy = 'p.last_name ASC, p.first_name ASC';
  if (params.sort === 'rating') {
    orderBy = 'p.rating DESC NULLS LAST, p.display_name ASC';
  }

  const result = await pool.query(
    `SELECT p.* FROM providers p WHERE ${whereClause} ORDER BY ${orderBy} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    queryParams
  );

  const results: ProviderSearchResult[] = result.rows.map((row: any) => ({
    provider: row,
    score: 0,
    highlights: {},
  }));

  logger.info('Provider search served from postgres fallback', {
    query: params.query,
    results: results.length,
    total,
  });

  return {
    results,
    total,
    page: params.page,
    page_size: params.page_size,
    took_ms: Date.now() - startTime,
    source: 'postgres',
  };
}

function buildSortClause(params: SearchParams): any[] {
  const sort: any[] = [];

  switch (params.sort) {
    case 'distance':
      if (params.location) {
        sort.push({
          _geo_distance: {
            location: {
              lat: params.location.lat,
              lon: params.location.lng,
            },
            order: 'asc',
            unit: 'mi',
            mode: 'min',
            distance_type: 'arc',
            ignore_unmapped: true,
          },
        });
      }
      break;

    case 'rating':
      sort.push({ rating: { order: 'desc', missing: '_last' } });
      break;

    case 'name':
      // This doesn't work great because display_name is a text field
      // and sorting on text fields is... not ideal in ES
      // TODO: add a display_name.keyword subfield for sorting
      sort.push({ 'display_name.keyword': { order: 'asc', unmapped_type: 'keyword' } });
      break;

    case 'relevance':
    default:
      sort.push({ _score: { order: 'desc' } });
      break;
  }

  // Secondary sort for consistency
  sort.push({ npi: { order: 'asc' } });

  return sort;
}

// Not part of the search but used by the reindex script
// Probably shouldn't live here but moving it would break the import in the script
export async function reindexAllProviders(): Promise<{ indexed: number; errors: number }> {
  const pool = getPool();
  const esClient = getESClient();
  const logger = getLogger();

  logger.info('Starting full provider reindex');

  // Delete and recreate index
  // WARNING: this causes search downtime. We should use aliases but haven't set that up.
  // TODO: implement zero-downtime reindex with aliases (PLAT-5678)

  const batchSize = 500;
  let offset = 0;
  let indexed = 0;
  let errors = 0;

  while (true) {
    const result = await pool.query(
      `SELECT p.*,
        (SELECT json_agg(pa.*) FROM provider_addresses pa WHERE pa.provider_id = p.id AND pa.is_primary = true) as primary_address,
        (SELECT json_agg(ps.*) FROM provider_specialties ps WHERE ps.provider_id = p.id) as specialties
      FROM providers p
      WHERE p.deleted_at IS NULL AND p.status = 'active'
      ORDER BY p.id
      LIMIT $1 OFFSET $2`,
      [batchSize, offset]
    );

    if (result.rows.length === 0) break;

    const operations = result.rows.flatMap((provider: any) => {
      const primaryAddr = provider.primary_address?.[0];
      const doc: any = {
        npi: provider.npi,
        first_name: provider.first_name,
        last_name: provider.last_name,
        display_name: provider.display_name,
        organization_name: provider.organization_name,
        specialty: provider.specialties?.map((s: any) => s.specialty_name) || [],
        taxonomy_code: provider.specialties?.map((s: any) => s.taxonomy_code) || [],
        accepting_new_patients: provider.accepting_new_patients,
        telehealth_available: provider.telehealth_available,
        languages: provider.languages || [],
        gender: provider.gender,
        credentials: provider.credentials || [],
        rating: provider.rating,
        bio: provider.bio,
        status: provider.status,
        network_ids: [], // TODO: populate
      };

      if (primaryAddr?.latitude && primaryAddr?.longitude) {
        doc.location = {
          lat: primaryAddr.latitude,
          lon: primaryAddr.longitude,
        };
      }

      return [
        { index: { _index: 'providers', _id: provider.id } },
        doc,
      ];
    });

    try {
      const bulkResponse = await esClient.bulk({ body: operations });

      if (bulkResponse.errors) {
        const errorItems = bulkResponse.items.filter((item: any) =>
          item.index?.error
        );
        errors += errorItems.length;
        logger.error('Bulk index errors', {
          count: errorItems.length,
          sample: errorItems.slice(0, 3).map((item: any) => item.index?.error),
        });
      }

      indexed += result.rows.length;
    } catch (err: any) {
      logger.error('Bulk index failed', { error: err.message, offset });
      errors += result.rows.length;
    }

    offset += batchSize;
    logger.info(`Reindex progress: ${indexed} indexed, ${errors} errors`);
  }

  logger.info('Reindex complete', { indexed, errors });
  return { indexed, errors };
}
