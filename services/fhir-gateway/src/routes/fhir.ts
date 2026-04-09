import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import axios from 'axios';
import { transformToFHIR, transformFromFHIR } from '../services/fhirTransformer';
import { buildSearchBundle } from '../services/bundleBuilder';
import { SUPPORTED_RESOURCE_TYPES, FHIRResourceType } from '../models/ResourceMapping';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

// Internal API base URLs
const INTERNAL_APIS: Record<string, string> = {
  Patient: process.env.PATIENT_API_URL || 'http://localhost:3001',
  Practitioner: process.env.PROVIDER_API_URL || 'http://localhost:3006',
  Condition: process.env.PATIENT_API_URL || 'http://localhost:3001',
  Observation: process.env.PATIENT_API_URL || 'http://localhost:3001',
  Encounter: process.env.SCHEDULING_API_URL || 'http://localhost:3003',
};

// Internal API path mappings
// Our internal APIs don't follow FHIR conventions, so we map paths
const INTERNAL_PATHS: Record<string, string> = {
  Patient: '/api/v1/patients',
  Practitioner: '/api/v1/providers',
  Condition: '/api/v1/patients/{patientId}/conditions',
  Observation: '/api/v1/patients/{patientId}/observations',
  Encounter: '/api/v1/encounters',
};

/**
 * GET /fhir/:resourceType
 * FHIR Search (search type interaction)
 */
router.get('/:resourceType', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();
    const { resourceType } = req.params;

    if (!SUPPORTED_RESOURCE_TYPES.includes(resourceType as FHIRResourceType)) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'not-supported',
          diagnostics: `Resource type '${resourceType}' is not supported. Supported types: ${SUPPORTED_RESOURCE_TYPES.join(', ')}`,
        }],
      });
    }

    // Map FHIR search parameters to internal API query params
    const internalParams = mapSearchParams(resourceType as FHIRResourceType, req.query);

    // Fetch from internal API
    const baseUrl = INTERNAL_APIS[resourceType];
    const path = INTERNAL_PATHS[resourceType];

    if (!baseUrl || !path) {
      return res.status(501).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'not-supported',
          diagnostics: `Search for ${resourceType} is not yet implemented`,
        }],
      });
    }

    let internalUrl = `${baseUrl}${path}`;

    // For patient-scoped resources, need patient ID
    if (path.includes('{patientId}')) {
      const patientParam = req.query['patient'] || req.query['subject'];
      if (!patientParam) {
        return res.status(400).json({
          resourceType: 'OperationOutcome',
          issue: [{
            severity: 'error',
            code: 'required',
            diagnostics: `Search parameter 'patient' is required for ${resourceType}`,
          }],
        });
      }
      // Resolve FHIR patient ID to internal ID
      const internalPatientId = await resolveInternalId('Patient', patientParam as string);
      if (!internalPatientId) {
        return res.status(404).json({
          resourceType: 'OperationOutcome',
          issue: [{
            severity: 'error',
            code: 'not-found',
            diagnostics: `Patient '${patientParam}' not found`,
          }],
        });
      }
      internalUrl = internalUrl.replace('{patientId}', internalPatientId);
    }

    logger.debug('Fetching from internal API', { url: internalUrl, params: internalParams });

    const response = await axios.get(internalUrl, {
      params: internalParams,
      headers: {
        'Authorization': req.headers.authorization || '',
        'X-Request-ID': req.headers['x-request-id'] || uuidv4(),
      },
      timeout: 10000,
    });

    const internalData = response.data.data || response.data.results || response.data;
    const totalCount = response.data.pagination?.total || response.data.total || (Array.isArray(internalData) ? internalData.length : 1);

    // Transform each result to FHIR
    const fhirResources = [];
    const items = Array.isArray(internalData) ? internalData : [internalData];

    for (const item of items) {
      try {
        const fhirResource = await transformToFHIR(resourceType as FHIRResourceType, item);
        if (fhirResource) {
          fhirResources.push(fhirResource);
        }
      } catch (transformErr: any) {
        logger.warn('Failed to transform resource to FHIR', {
          resourceType,
          internalId: item.id,
          error: transformErr.message,
        });
        // Skip this resource but continue with others
      }
    }

    // Build FHIR Bundle
    const bundle = buildSearchBundle({
      resourceType: resourceType as FHIRResourceType,
      resources: fhirResources,
      total: totalCount,
      page: parseInt(req.query._page as string) || parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query._count as string) || 20,
      baseUrl: `${req.protocol}://${req.get('host')}/fhir`,
      searchParams: req.query,
    });

    res.json(bundle);
  } catch (err: any) {
    if (err.response?.status === 404) {
      return res.json({
        resourceType: 'Bundle',
        type: 'searchset',
        total: 0,
        entry: [],
      });
    }
    next(err);
  }
});

/**
 * GET /fhir/:resourceType/:id
 * FHIR Read (read interaction)
 */
router.get('/:resourceType/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();
    const { resourceType, id } = req.params;

    if (!SUPPORTED_RESOURCE_TYPES.includes(resourceType as FHIRResourceType)) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'not-supported',
          diagnostics: `Resource type '${resourceType}' is not supported`,
        }],
      });
    }

    // Resolve FHIR ID to internal ID
    const internalId = await resolveInternalId(resourceType as FHIRResourceType, id);
    if (!internalId) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'not-found',
          diagnostics: `${resourceType}/${id} not found`,
        }],
      });
    }

    // Fetch from internal API
    const baseUrl = INTERNAL_APIS[resourceType];
    let path = INTERNAL_PATHS[resourceType];

    // Remove patient scoping for direct reads
    if (path.includes('{patientId}')) {
      // For Condition/Observation, we need a different internal endpoint for direct reads
      // This is a hack - our internal API doesn't support reading conditions by ID directly
      // without knowing the patient. We work around this by looking up the patient from the mapping.
      const pool = getPool();
      const mapping = await pool.query(
        `SELECT internal_resource_id, internal_source_system FROM resource_mappings
         WHERE fhir_resource_type = $1 AND fhir_resource_id = $2`,
        [resourceType, id]
      );
      if (mapping.rows.length === 0) {
        return res.status(404).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'not-found', diagnostics: `${resourceType}/${id} not found` }],
        });
      }
      // Just use the patient API with the internal ID
      path = `/api/v1/${resourceType.toLowerCase()}s/${mapping.rows[0].internal_resource_id}`;
    } else {
      path = `${path}/${internalId}`;
    }

    const response = await axios.get(`${baseUrl}${path}`, {
      headers: {
        'Authorization': req.headers.authorization || '',
        'X-Request-ID': req.headers['x-request-id'] || uuidv4(),
      },
      timeout: 10000,
    });

    const internalData = response.data.data || response.data;
    const fhirResource = await transformToFHIR(resourceType as FHIRResourceType, internalData);

    if (!fhirResource) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: `${resourceType}/${id} not found` }],
      });
    }

    // Set ETag and Last-Modified headers
    // FHIR spec recommends this for caching/conditional requests
    const version = fhirResource.meta?.versionId || '1';
    res.setHeader('ETag', `W/"${version}"`);
    if (fhirResource.meta?.lastUpdated) {
      res.setHeader('Last-Modified', new Date(fhirResource.meta.lastUpdated).toUTCString());
    }

    res.json(fhirResource);
  } catch (err: any) {
    if (err.response?.status === 404) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: `Resource not found` }],
      });
    }
    next(err);
  }
});

/**
 * POST /fhir/:resourceType
 * FHIR Create (create interaction)
 */
router.post('/:resourceType', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();
    const { resourceType } = req.params;

    if (!SUPPORTED_RESOURCE_TYPES.includes(resourceType as FHIRResourceType)) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-supported', diagnostics: `Resource type '${resourceType}' is not supported` }],
      });
    }

    const fhirResource = req.body;

    // Basic validation
    if (fhirResource.resourceType !== resourceType) {
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'invalid',
          diagnostics: `Resource type in body '${fhirResource.resourceType}' does not match URL '${resourceType}'`,
        }],
      });
    }

    // Server should assign the ID, not the client
    if (fhirResource.id) {
      logger.warn('Client provided resource ID in create request, ignoring', {
        resourceType,
        providedId: fhirResource.id,
      });
      // Don't reject - just ignore the client-provided ID
      // Some FHIR clients include it even on creates
    }

    // Transform from FHIR to internal format
    const internalData = await transformFromFHIR(resourceType as FHIRResourceType, fhirResource);

    // Create via internal API
    const baseUrl = INTERNAL_APIS[resourceType];
    let path = INTERNAL_PATHS[resourceType];

    // Handle patient-scoped resources
    if (path.includes('{patientId}')) {
      // Extract patient reference
      const patientRef = fhirResource.subject?.reference || fhirResource.patient?.reference;
      if (!patientRef) {
        return res.status(400).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'required', diagnostics: 'Patient/subject reference is required' }],
        });
      }
      const patientFhirId = patientRef.replace('Patient/', '');
      const internalPatientId = await resolveInternalId('Patient', patientFhirId);
      if (!internalPatientId) {
        return res.status(400).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'not-found', diagnostics: `Referenced Patient/${patientFhirId} not found` }],
        });
      }
      path = path.replace('{patientId}', internalPatientId);
    }

    const response = await axios.post(`${baseUrl}${path}`, internalData, {
      headers: {
        'Authorization': req.headers.authorization || '',
        'Content-Type': 'application/json',
        'X-Request-ID': req.headers['x-request-id'] || uuidv4(),
      },
      timeout: 10000,
    });

    const createdInternalData = response.data.data || response.data;
    const internalId = createdInternalData.id;

    // Create FHIR resource ID and mapping
    const fhirId = uuidv4();
    const pool = getPool();
    await pool.query(`
      INSERT INTO resource_mappings (id, fhir_resource_type, fhir_resource_id, internal_resource_type, internal_resource_id, internal_source_system, version, last_synced_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW(), NOW())
    `, [uuidv4(), resourceType, fhirId, resourceType.toLowerCase(), internalId, 'fhir-gateway']);

    // Transform back to FHIR for the response
    const createdFhirResource = await transformToFHIR(resourceType as FHIRResourceType, createdInternalData);
    if (createdFhirResource) {
      createdFhirResource.id = fhirId;
    }

    // Set Location header per FHIR spec
    res.setHeader('Location', `/fhir/${resourceType}/${fhirId}`);
    res.status(201).json(createdFhirResource);
  } catch (err: any) {
    if (err.response?.status === 400) {
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'invalid',
          diagnostics: err.response.data?.error || 'Invalid resource',
        }],
      });
    }
    next(err);
  }
});

/**
 * PUT /fhir/:resourceType/:id
 * FHIR Update (update interaction)
 */
router.put('/:resourceType/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();
    const { resourceType, id } = req.params;

    if (!SUPPORTED_RESOURCE_TYPES.includes(resourceType as FHIRResourceType)) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-supported', diagnostics: `Resource type '${resourceType}' is not supported` }],
      });
    }

    const fhirResource = req.body;

    // FHIR spec: resource ID in body must match URL
    if (fhirResource.id && fhirResource.id !== id) {
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'invalid',
          diagnostics: `Resource ID in body '${fhirResource.id}' does not match URL '${id}'`,
        }],
      });
    }

    const internalId = await resolveInternalId(resourceType as FHIRResourceType, id);
    if (!internalId) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: `${resourceType}/${id} not found` }],
      });
    }

    // Check If-Match for optimistic locking (optional per FHIR spec)
    // We support it but don't enforce it
    const ifMatch = req.headers['if-match'];
    if (ifMatch) {
      logger.debug('If-Match header present', { ifMatch });
      // TODO: implement version checking
    }

    const internalData = await transformFromFHIR(resourceType as FHIRResourceType, fhirResource);

    const baseUrl = INTERNAL_APIS[resourceType];
    const path = `${INTERNAL_PATHS[resourceType]}/${internalId}`;

    await axios.put(`${baseUrl}${path}`, internalData, {
      headers: {
        'Authorization': req.headers.authorization || '',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    // Increment version in mapping
    const pool = getPool();
    await pool.query(
      `UPDATE resource_mappings SET version = version + 1, last_synced_at = NOW(), updated_at = NOW()
       WHERE fhir_resource_type = $1 AND fhir_resource_id = $2`,
      [resourceType, id]
    );

    // Fetch updated resource
    const updatedResponse = await axios.get(`${baseUrl}${path}`, {
      headers: { 'Authorization': req.headers.authorization || '' },
    });

    const updatedFhir = await transformToFHIR(
      resourceType as FHIRResourceType,
      updatedResponse.data.data || updatedResponse.data
    );
    if (updatedFhir) {
      updatedFhir.id = id;
    }

    res.json(updatedFhir);
  } catch (err: any) {
    next(err);
  }
});

// Helper: resolve FHIR resource ID to internal ID
async function resolveInternalId(resourceType: FHIRResourceType, fhirId: string): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query(
    'SELECT internal_resource_id FROM resource_mappings WHERE fhir_resource_type = $1 AND fhir_resource_id = $2',
    [resourceType, fhirId]
  );

  if (result.rows.length > 0) {
    return result.rows[0].internal_resource_id;
  }

  // Maybe the client is using the internal ID directly (common with our mobile app)
  // Try to look up by internal ID
  const reverseResult = await pool.query(
    'SELECT internal_resource_id FROM resource_mappings WHERE fhir_resource_type = $1 AND internal_resource_id = $2',
    [resourceType, fhirId]
  );

  if (reverseResult.rows.length > 0) {
    return reverseResult.rows[0].internal_resource_id;
  }

  // Last resort - maybe it IS the internal ID and we just don't have a mapping
  // This happens for resources that were created before the FHIR gateway existed
  // We should create a mapping on the fly, but for now just return the ID as-is
  // TODO: create mapping on first access (PLAT-8567)
  return fhirId;
}

// Helper: map FHIR search parameters to internal API parameters
function mapSearchParams(resourceType: FHIRResourceType, query: any): Record<string, any> {
  const params: Record<string, any> = {};

  // Common FHIR search params
  if (query._count) params.page_size = query._count;
  if (query._page || query.page) params.page = query._page || query.page;
  if (query._sort) params.sort = mapSortParam(query._sort);

  // Resource-specific mappings
  switch (resourceType) {
    case 'Patient':
      if (query.name) params.q = query.name;
      if (query.family) params.last_name = query.family;
      if (query.given) params.first_name = query.given;
      if (query.birthdate) params.date_of_birth = query.birthdate;
      if (query.gender) params.gender = mapGender(query.gender);
      if (query.identifier) params.mrn = extractIdentifierValue(query.identifier);
      if (query.telecom) params.phone = query.telecom;
      break;

    case 'Practitioner':
      if (query.name) params.q = query.name;
      if (query.family) params.last_name = query.family;
      if (query.given) params.first_name = query.given;
      if (query.identifier) params.npi = extractIdentifierValue(query.identifier);
      if (query.specialty) params.specialty = query.specialty;
      break;

    case 'Encounter':
      if (query.patient || query.subject) params.patient_id = query.patient || query.subject;
      if (query.date) params.date = query.date;
      if (query.status) params.status = query.status;
      if (query.class) params.encounter_class = query.class;
      break;

    case 'Condition':
    case 'Observation':
      // These are patient-scoped, handled in the route
      if (query.code) params.code = query.code;
      if (query.category) params.category = query.category;
      if (query.date) params.date = query.date;
      break;
  }

  return params;
}

function mapSortParam(sort: string): string {
  // FHIR uses -field for descending, our API uses field:desc
  if (sort.startsWith('-')) {
    return `${sort.substring(1)}:desc`;
  }
  return sort;
}

function mapGender(fhirGender: string): string {
  // FHIR uses full words, our internal API uses M/F
  const map: Record<string, string> = {
    male: 'M',
    female: 'F',
    other: 'O',
    unknown: 'U',
  };
  return map[fhirGender.toLowerCase()] || fhirGender;
}

function extractIdentifierValue(identifier: string): string {
  // FHIR identifier format: system|value
  const parts = identifier.split('|');
  return parts.length > 1 ? parts[1] : parts[0];
}

export default router;
