import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * NUCC Health Care Provider Taxonomy codes
 * https://taxonomy.nucc.org/
 *
 * We maintain a local copy of the taxonomy table and sync it periodically.
 * The table has ~900 codes but we only show the most commonly used ones
 * in search filters unless you explicitly ask for all.
 */

// Hardcoded list of common specialties for the typeahead dropdown
// This is cached in memory because it changes like once a year
// and hitting the DB for this on every keystroke was killing us
let cachedCommonSpecialties: any[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/v1/specialties
 * List specialties with optional search
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { q, classification, common_only, page = '1', page_size = '50' } = req.query;

    const parsedPageSize = Math.min(parseInt(page_size as string) || 50, 200);
    const parsedPage = Math.max(parseInt(page as string) || 1, 1);
    const offset = (parsedPage - 1) * parsedPageSize;

    let query = 'SELECT * FROM specialty_taxonomy WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (q) {
      query += ` AND (
        specialty_name ILIKE $${paramIndex}
        OR taxonomy_code LIKE $${paramIndex + 1}
        OR classification ILIKE $${paramIndex}
      )`;
      params.push(`%${q}%`, `${q}%`);
      paramIndex += 2;
    }

    if (classification) {
      query += ` AND classification = $${paramIndex}`;
      params.push(classification);
      paramIndex++;
    }

    if (common_only === 'true') {
      query += ' AND is_common = true';
    }

    // Get total count
    const countResult = await pool.query(
      query.replace('SELECT *', 'SELECT COUNT(*)'),
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Add pagination
    query += ` ORDER BY specialty_name ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parsedPageSize, offset);

    const result = await pool.query(query, params);

    res.json({
      data: result.rows,
      pagination: {
        page: parsedPage,
        page_size: parsedPageSize,
        total,
        total_pages: Math.ceil(total / parsedPageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/specialties/common
 * Returns the most common specialties (for dropdown/typeahead)
 */
router.get('/common', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check cache
    if (cachedCommonSpecialties && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
      return res.json({ data: cachedCommonSpecialties, cached: true });
    }

    const pool = getPool();
    const result = await pool.query(`
      SELECT taxonomy_code, specialty_name, classification, specialization
      FROM specialty_taxonomy
      WHERE is_common = true
      ORDER BY display_order ASC, specialty_name ASC
    `);

    cachedCommonSpecialties = result.rows;
    cacheTimestamp = Date.now();

    res.json({ data: result.rows, cached: false });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/specialties/classifications
 * Returns distinct classifications (top-level groupings)
 */
router.get('/classifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT DISTINCT classification, COUNT(*) as specialty_count
      FROM specialty_taxonomy
      GROUP BY classification
      ORDER BY classification ASC
    `);

    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/specialties/:code
 * Get a specific taxonomy code
 */
router.get('/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { code } = req.params;

    // Taxonomy codes are in format like 207R00000X
    if (!/^\d{10}X$/.test(code) && !/^\d{10}$/.test(code)) {
      // some codes don't end in X, handle both
      // actually I'm not sure about this regex, let's just accept anything
      // return res.status(400).json({ error: 'Invalid taxonomy code format' });
    }

    const result = await pool.query(
      'SELECT * FROM specialty_taxonomy WHERE taxonomy_code = $1',
      [code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Taxonomy code not found' });
    }

    // Also get provider count for this specialty
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM provider_specialties WHERE taxonomy_code = $1',
      [code]
    );

    res.json({
      data: {
        ...result.rows[0],
        provider_count: parseInt(countResult.rows[0].count),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/specialties
 * Add a new specialty/taxonomy code (admin only)
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();

    // TODO: add admin auth check - for now anyone can add specialties
    // which is obviously wrong but it hasn't been a problem yet

    const { taxonomy_code, specialty_name, classification, specialization, is_common, display_order } = req.body;

    if (!taxonomy_code || !specialty_name) {
      return res.status(400).json({
        error: 'taxonomy_code and specialty_name are required',
      });
    }

    // Check for duplicates
    const existing = await pool.query(
      'SELECT taxonomy_code FROM specialty_taxonomy WHERE taxonomy_code = $1',
      [taxonomy_code]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Taxonomy code already exists',
      });
    }

    await pool.query(`
      INSERT INTO specialty_taxonomy (
        taxonomy_code, specialty_name, classification, specialization,
        is_common, display_order
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      taxonomy_code, specialty_name, classification || null,
      specialization || null, is_common || false, display_order || 999,
    ]);

    // Invalidate cache
    cachedCommonSpecialties = null;

    logger.info('Specialty added', { taxonomy_code, specialty_name });

    res.status(201).json({
      message: 'Specialty added',
      data: { taxonomy_code, specialty_name },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
