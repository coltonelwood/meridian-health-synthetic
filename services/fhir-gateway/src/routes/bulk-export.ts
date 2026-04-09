import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { SUPPORTED_RESOURCE_TYPES } from '../models/ResourceMapping';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * FHIR Bulk Data Export ($export)
 * Implementation Guide: https://hl7.org/fhir/uv/bulkdata/
 *
 * This is a PARTIAL implementation. The full spec requires:
 * 1. Kick off request (POST /$export) - IMPLEMENTED (sort of)
 * 2. Status polling (GET /status/:id) - IMPLEMENTED (partially)
 * 3. File download (GET /download/:id) - NOT IMPLEMENTED
 * 4. Delete request (DELETE /status/:id) - NOT IMPLEMENTED
 *
 * We currently only support system-level export ($export), not
 * patient-level (Patient/$export) or group-level (Group/:id/$export).
 *
 * The export is faked for now - we don't actually generate NDJSON files.
 * We just record the export request and return a status URL. The actual
 * export would need to:
 * - Query all resources
 * - Transform each to FHIR
 * - Write to NDJSON files (one per resource type)
 * - Store files in S3
 * - Update the status record with download URLs
 *
 * This is a significant amount of work and we haven't prioritized it
 * because our only bulk data consumer (the state HIE) is fine with
 * our custom batch API for now.
 *
 * TODO: Actually implement this properly (PLAT-9001)
 * TODO: Support _since parameter for incremental exports
 * TODO: Support _type parameter to filter resource types
 * TODO: Support _typeFilter for search parameters
 * TODO: Patient-level export
 * TODO: Group-level export
 * TODO: Access control / SMART Backend Services auth
 */

interface BulkExportJob {
  id: string;
  status: 'accepted' | 'in_progress' | 'complete' | 'error';
  request_url: string;
  resource_types: string[];
  since?: string;
  type_filter?: Record<string, string>;
  output?: Array<{
    type: string;
    url: string;
    count: number;
  }>;
  error?: string;
  requested_at: Date;
  completed_at?: Date;
  expires_at?: Date;
}

/**
 * POST /fhir/$export
 * Kick off a bulk data export
 */
router.post('/\\$export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();
    const pool = getPool();

    // Check Prefer header - should be respond-async
    const prefer = req.headers['prefer'];
    if (prefer && !prefer.includes('respond-async')) {
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'invalid',
          diagnostics: 'Bulk export requires Prefer: respond-async header',
        }],
      });
    }

    // Parse parameters
    const _type = req.query._type as string;
    const _since = req.query._since as string;
    const _typeFilter = req.query._typeFilter as string;

    const resourceTypes = _type
      ? _type.split(',').filter(t => SUPPORTED_RESOURCE_TYPES.includes(t as any))
      : [...SUPPORTED_RESOURCE_TYPES];

    if (resourceTypes.length === 0) {
      return res.status(400).json({
        resourceType: 'OperationOutcome',
        issue: [{
          severity: 'error',
          code: 'invalid',
          diagnostics: `No supported resource types in _type parameter. Supported: ${SUPPORTED_RESOURCE_TYPES.join(', ')}`,
        }],
      });
    }

    // Create export job
    const jobId = uuidv4();
    const now = new Date();

    await pool.query(`
      INSERT INTO bulk_export_jobs (id, status, request_url, resource_types, since_param, requested_at)
      VALUES ($1, 'accepted', $2, $3, $4, $5)
    `, [jobId, req.originalUrl, resourceTypes, _since || null, now]);

    logger.info('Bulk export job created', {
      jobId,
      resourceTypes,
      since: _since,
    });

    // TODO: Actually start the export job (enqueue to a worker)
    // For now we just mark it as accepted and it'll sit there forever
    // The status endpoint will always return "in progress"

    // Per FHIR spec, return 202 Accepted with Content-Location header
    res.setHeader('Content-Location', `${req.protocol}://${req.get('host')}/fhir/$export-status/${jobId}`);
    res.status(202).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /fhir/$export-status/:jobId
 * Check bulk export status
 */
router.get('/\\$export-status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { jobId } = req.params;

    const result = await pool.query(
      'SELECT * FROM bulk_export_jobs WHERE id = $1',
      [jobId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: 'Export job not found' }],
      });
    }

    const job = result.rows[0];

    switch (job.status) {
      case 'accepted':
      case 'in_progress':
        // Per FHIR spec: return 202 with X-Progress header
        res.setHeader('X-Progress', `Export ${job.status}`);
        res.setHeader('Retry-After', '120'); // check back in 2 minutes
        return res.status(202).end();

      case 'complete':
        // Per FHIR spec: return 200 with output manifest
        return res.json({
          transactionTime: job.completed_at?.toISOString(),
          request: job.request_url,
          requiresAccessToken: true,
          output: job.output || [],
          error: [],
        });

      case 'error':
        return res.status(500).json({
          resourceType: 'OperationOutcome',
          issue: [{
            severity: 'error',
            code: 'exception',
            diagnostics: job.error || 'Export failed',
          }],
        });

      default:
        return res.status(500).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'exception', diagnostics: 'Unknown job status' }],
        });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /fhir/$export-status/:jobId
 * Cancel a bulk export job
 */
router.delete('/\\$export-status/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { jobId } = req.params;

    const result = await pool.query(
      "UPDATE bulk_export_jobs SET status = 'error', error = 'Cancelled by client' WHERE id = $1 RETURNING id",
      [jobId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found', diagnostics: 'Export job not found' }],
      });
    }

    // TODO: actually cancel the running export if it's in progress
    // Currently this just marks it as errored in the database

    res.status(202).end();
  } catch (err) {
    next(err);
  }
});

export default router;
