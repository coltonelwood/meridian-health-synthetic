import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import { DocumentType, DocumentStatus, DocumentSearchParams } from '../models/Document';
import { uploadFile, downloadFile, deleteFile } from '../services/storageService';
import { processDocument } from '../services/documentProcessor';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;
const getUpload = () => (global as any).__upload;

/**
 * GET /api/v1/documents
 * List/search documents
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const params: DocumentSearchParams = {
      patient_id: req.query.patient_id as string,
      document_type: req.query.type as DocumentType,
      encounter_id: req.query.encounter_id as string,
      from_date: req.query.from_date as string,
      to_date: req.query.to_date as string,
      uploaded_by: req.query.uploaded_by as string,
      tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
      q: req.query.q as string,
      status: (req.query.status as DocumentStatus) || DocumentStatus.ACTIVE,
      page: parseInt(req.query.page as string) || 1,
      page_size: Math.min(parseInt(req.query.page_size as string) || 25, 100),
      sort: req.query.sort as string || 'created_at',
    };

    const conditions: string[] = ['d.deleted_at IS NULL'];
    const queryParams: any[] = [];
    let paramIndex = 1;

    if (params.patient_id) {
      conditions.push(`d.patient_id = $${paramIndex++}`);
      queryParams.push(params.patient_id);
    }

    if (params.document_type) {
      conditions.push(`d.document_type = $${paramIndex++}`);
      queryParams.push(params.document_type);
    }

    if (params.encounter_id) {
      conditions.push(`d.encounter_id = $${paramIndex++}`);
      queryParams.push(params.encounter_id);
    }

    if (params.from_date) {
      conditions.push(`d.created_at >= $${paramIndex++}`);
      queryParams.push(params.from_date);
    }

    if (params.to_date) {
      conditions.push(`d.created_at <= $${paramIndex++}`);
      queryParams.push(params.to_date);
    }

    if (params.uploaded_by) {
      conditions.push(`d.uploaded_by = $${paramIndex++}`);
      queryParams.push(params.uploaded_by);
    }

    if (params.status) {
      conditions.push(`d.status = $${paramIndex++}`);
      queryParams.push(params.status);
    }

    if (params.tags?.length) {
      conditions.push(`d.tags && $${paramIndex++}`);
      queryParams.push(params.tags);
    }

    // Full text search in extracted content
    if (params.q) {
      conditions.push(`(
        d.title ILIKE $${paramIndex}
        OR d.description ILIKE $${paramIndex}
        OR d.text_content ILIKE $${paramIndex}
        OR d.original_filename ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${params.q}%`);
      paramIndex++;
    }

    // Only show latest version by default
    conditions.push('d.is_latest_version = true');

    const whereClause = conditions.join(' AND ');
    const offset = (params.page! - 1) * params.page_size!;

    // Validate sort field
    const allowedSorts = ['created_at', 'title', 'document_type', 'file_size_bytes', 'updated_at'];
    const sortField = allowedSorts.includes(params.sort!) ? params.sort : 'created_at';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM documents d WHERE ${whereClause}`,
      queryParams
    );
    const total = parseInt(countResult.rows[0].count);

    queryParams.push(params.page_size, offset);
    const result = await pool.query(
      `SELECT d.id, d.patient_id, d.encounter_id, d.document_type, d.title,
        d.description, d.original_filename, d.mime_type, d.file_size_bytes,
        d.thumbnail_key, d.uploaded_by, d.uploaded_by_name, d.authored_by,
        d.authored_date, d.signed_by, d.signed_at, d.tags, d.category,
        d.version, d.is_confidential, d.status, d.created_at, d.updated_at
      FROM documents d
      WHERE ${whereClause}
      ORDER BY d.${sortField} DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      queryParams
    );

    // Don't include text_content in list results - it can be very large
    const documents = result.rows.map((doc: any) => ({
      ...doc,
      file_size_human: formatFileSize(doc.file_size_bytes),
    }));

    res.json({
      data: documents,
      pagination: {
        page: params.page,
        page_size: params.page_size,
        total,
        total_pages: Math.ceil(total / params.page_size!),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/documents/:id
 * Get document metadata
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = result.rows[0];

    // Get version history
    const versions = await pool.query(
      `SELECT id, version, created_at, uploaded_by_name, file_size_bytes
       FROM documents
       WHERE (id = $1 OR parent_document_id = $1 OR id = (SELECT parent_document_id FROM documents WHERE id = $1))
         AND deleted_at IS NULL
       ORDER BY version DESC`,
      [id]
    );

    res.json({
      data: {
        ...doc,
        file_size_human: formatFileSize(doc.file_size_bytes),
        versions: versions.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/documents/:id/download
 * Download document file
 */
router.get('/:id/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = result.rows[0];

    // Check confidentiality
    if (doc.is_confidential) {
      // TODO: check user's role against restricted_to_roles
      // For now just log it
      logger.warn('Confidential document downloaded', {
        documentId: id,
        requestedBy: (req as any).user?.id || 'unknown',
      });
    }

    // Get file from storage
    const fileStream = await downloadFile(doc.storage_backend, doc.storage_key, doc.storage_bucket);

    // Set response headers
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_filename)}"`);
    if (doc.file_size_bytes) {
      res.setHeader('Content-Length', doc.file_size_bytes);
    }

    // Audit log
    logger.info('Document downloaded', {
      documentId: id,
      patientId: doc.patient_id,
      documentType: doc.document_type,
      requestedBy: (req as any).user?.id,
    });

    // Stream the file
    if (typeof fileStream === 'string') {
      // Local file path (legacy)
      res.sendFile(fileStream);
    } else {
      fileStream.pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/documents/:id/thumbnail
 * Get document thumbnail (for images and PDFs)
 */
router.get('/:id/thumbnail', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      'SELECT thumbnail_key, thumbnail_generated, storage_backend, storage_bucket FROM documents WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = result.rows[0];

    if (!doc.thumbnail_generated || !doc.thumbnail_key) {
      return res.status(404).json({ error: 'No thumbnail available' });
    }

    const fileStream = await downloadFile(doc.storage_backend, doc.thumbnail_key, doc.storage_bucket);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache for 24h

    if (typeof fileStream === 'string') {
      res.sendFile(fileStream);
    } else {
      fileStream.pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/documents
 * Upload a new document
 */
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  const upload = getUpload();

  // Use multer for file upload handling
  upload.single('file')(req, res, async (uploadErr: any) => {
    if (uploadErr) {
      return next(uploadErr);
    }

    try {
      const pool = getPool();
      const logger = getLogger();

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { patient_id, document_type, title, description, encounter_id, tags, category, is_confidential, authored_by, authored_date } = req.body;

      if (!patient_id) {
        // Clean up temp file
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'patient_id is required' });
      }

      const id = uuidv4();
      const fileExt = path.extname(req.file.originalname).toLowerCase();
      const storageKey = `documents/${patient_id}/${id}${fileExt}`;
      const storageBucket = process.env.MINIO_BUCKET || 'clinical-documents';

      // Upload to storage
      let storageBackend: string;
      try {
        await uploadFile(storageKey, req.file.path, req.file.mimetype, storageBucket);
        storageBackend = process.env.STORAGE_BACKEND || 'minio';
      } catch (storageErr: any) {
        logger.error('Failed to upload to primary storage, falling back to local', {
          error: storageErr.message,
        });
        // Fallback to local storage
        const localPath = path.join(process.env.LOCAL_STORAGE_PATH || '/var/meridian/documents', storageKey);
        const localDir = path.dirname(localPath);
        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }
        fs.copyFileSync(req.file.path, localPath);
        storageBackend = 'local';
      }

      // Save metadata
      const parsedTags = tags ? (typeof tags === 'string' ? tags.split(',').map((t: string) => t.trim()) : tags) : [];

      await pool.query(`
        INSERT INTO documents (
          id, patient_id, encounter_id, document_type, title, description,
          original_filename, mime_type, file_size_bytes, file_extension,
          storage_backend, storage_key, storage_bucket,
          thumbnail_generated, text_extracted, ccda_parsed,
          uploaded_by, uploaded_by_name, authored_by, authored_date,
          tags, category, version, is_latest_version,
          is_confidential, status, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, false, false, false,
          $14, $15, $16, $17,
          $18, $19, 1, true,
          $20, $21, NOW(), NOW()
        )
      `, [
        id, patient_id, encounter_id || null,
        document_type || DocumentType.OTHER,
        title || req.file.originalname,
        description || null,
        req.file.originalname, req.file.mimetype,
        req.file.size, fileExt,
        storageBackend, storageKey, storageBucket,
        (req as any).user?.id || 'system',
        (req as any).user?.name || null,
        authored_by || null, authored_date || null,
        parsedTags, category || null,
        is_confidential === 'true' || is_confidential === true,
        DocumentStatus.PROCESSING,
      ]);

      // Clean up temp file
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // temp file cleanup is best-effort
      }

      // Process document asynchronously (text extraction, thumbnails, etc.)
      processDocument(id).catch(err => {
        logger.error('Document processing failed', {
          documentId: id,
          error: err.message,
        });
      });

      logger.info('Document uploaded', {
        documentId: id,
        patientId: patient_id,
        documentType: document_type,
        fileName: req.file.originalname,
        fileSize: req.file.size,
      });

      res.status(201).json({
        data: {
          id,
          title: title || req.file.originalname,
          file_size_human: formatFileSize(req.file.size),
          status: DocumentStatus.PROCESSING,
        },
        message: 'Document uploaded successfully. Processing in progress.',
      });
    } catch (err) {
      // Clean up temp file on error
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch { }
      }
      next(err);
    }
  });
});

/**
 * DELETE /api/v1/documents/:id
 * Soft delete a document
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const { id } = req.params;
    const { reason } = req.body || {};

    const result = await pool.query(
      `UPDATE documents SET
        status = $1, deleted_at = NOW(), deleted_by = $2, delete_reason = $3, updated_at = NOW()
       WHERE id = $4 AND deleted_at IS NULL
       RETURNING id, storage_backend, storage_key, storage_bucket`,
      [DocumentStatus.DELETED, (req as any).user?.id || 'unknown', reason || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Don't delete the actual file - just mark as deleted
    // We keep files for compliance/legal hold purposes
    // There's a separate cleanup job that purges files after the retention period
    // (currently 7 years per HIPAA requirement)
    logger.info('Document soft-deleted', {
      documentId: id,
      deletedBy: (req as any).user?.id,
      reason,
    });

    res.json({ message: 'Document deleted', id });
  } catch (err) {
    next(err);
  }
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default router;
