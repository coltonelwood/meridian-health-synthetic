import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { downloadFile } from './storageService';
import { parseCCDA } from './ccdaParser';

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * Document Processor
 *
 * Processes uploaded documents asynchronously:
 * 1. Text extraction (from PDFs)
 * 2. Thumbnail generation (from images and PDF first page)
 * 3. C-CDA parsing (for clinical document exchange)
 * 4. OCR (not implemented yet)
 *
 * This runs after the upload response is sent, so it doesn't
 * block the upload. The document status transitions:
 * uploading -> processing -> active (or error)
 *
 * We tried running this as a separate worker but it added complexity
 * without much benefit since we don't have that many uploads.
 * If upload volume increases we should move this to a Bull queue.
 *
 * Known issues:
 * - PDF text extraction is slow for large files (100+ pages)
 * - Thumbnail generation fails silently for some TIFF formats
 * - C-CDA parsing is very fragile and breaks on non-standard documents
 * - No OCR support yet - scanned documents have no text content
 *   (we evaluated Tesseract but the accuracy was too low for clinical docs)
 */

export async function processDocument(documentId: string): Promise<void> {
  const pool = getPool();
  const logger = getLogger();

  logger.info('Processing document', { documentId });

  try {
    // Fetch document metadata
    const result = await pool.query(
      'SELECT * FROM documents WHERE id = $1',
      [documentId]
    );

    if (result.rows.length === 0) {
      logger.error('Document not found for processing', { documentId });
      return;
    }

    const doc = result.rows[0];

    // Get the file content
    const fileContent = await downloadFile(doc.storage_backend, doc.storage_key, doc.storage_bucket);

    let textContent: string | null = null;
    let thumbnailKey: string | null = null;
    let ccdaParsed = false;
    let processingError: string | null = null;

    // Step 1: Extract text from PDFs
    if (doc.mime_type === 'application/pdf') {
      try {
        textContent = await extractPDFText(fileContent);
        logger.debug('PDF text extracted', {
          documentId,
          textLength: textContent?.length || 0,
        });
      } catch (err: any) {
        logger.warn('PDF text extraction failed', {
          documentId,
          error: err.message,
        });
        processingError = `PDF text extraction failed: ${err.message}`;
      }
    }

    // Step 2: Generate thumbnail
    if (isImageType(doc.mime_type) || doc.mime_type === 'application/pdf') {
      try {
        thumbnailKey = await generateThumbnail(fileContent, doc.mime_type, documentId, doc.storage_bucket);
        logger.debug('Thumbnail generated', { documentId, thumbnailKey });
      } catch (err: any) {
        logger.warn('Thumbnail generation failed', {
          documentId,
          error: err.message,
        });
        // Don't set processingError for thumbnail failure - it's non-critical
      }
    }

    // Step 3: Parse C-CDA
    if (doc.document_type === 'ccda' || doc.mime_type === 'application/xml' || doc.mime_type === 'text/xml' || doc.mime_type === 'application/cda+xml') {
      try {
        const xmlContent = await getFileAsString(fileContent);
        if (xmlContent.includes('ClinicalDocument') || xmlContent.includes('clinicaldocument')) {
          const ccdaData = await parseCCDA(xmlContent);
          ccdaParsed = true;

          // Update document with C-CDA specific metadata
          await pool.query(`
            UPDATE documents SET
              ccda_parsed = true,
              ccda_document_type = $1,
              ccda_patient_name = $2,
              document_type = 'ccda'
            WHERE id = $3
          `, [
            ccdaData.documentType,
            ccdaData.patientName,
            documentId,
          ]);

          logger.info('C-CDA parsed', {
            documentId,
            documentType: ccdaData.documentType,
          });
        }
      } catch (err: any) {
        logger.warn('C-CDA parsing failed', {
          documentId,
          error: err.message,
        });
        processingError = processingError
          ? `${processingError}; C-CDA parsing failed: ${err.message}`
          : `C-CDA parsing failed: ${err.message}`;
      }
    }

    // Update document status
    const newStatus = processingError ? 'active' : 'active'; // even with errors, make it active
    // We used to mark as 'error' but users complained they couldn't find their documents

    await pool.query(`
      UPDATE documents SET
        status = $1,
        text_content = $2,
        text_extracted = $3,
        text_extraction_error = $4,
        thumbnail_key = $5,
        thumbnail_generated = $6,
        updated_at = NOW()
      WHERE id = $7
    `, [
      newStatus,
      textContent,
      !!textContent,
      processingError,
      thumbnailKey,
      !!thumbnailKey,
      documentId,
    ]);

    logger.info('Document processing complete', {
      documentId,
      status: newStatus,
      textExtracted: !!textContent,
      thumbnailGenerated: !!thumbnailKey,
      ccdaParsed,
      hasError: !!processingError,
    });
  } catch (err: any) {
    logger.error('Document processing failed', {
      documentId,
      error: err.message,
      stack: err.stack,
    });

    // Update status to error
    await pool.query(
      "UPDATE documents SET status = 'error', text_extraction_error = $1, updated_at = NOW() WHERE id = $2",
      [`Processing error: ${err.message}`, documentId]
    ).catch(() => {}); // don't throw if this update also fails
  }
}

/**
 * Extract text from a PDF file.
 * Uses pdf-parse library which is decent but not great for
 * scanned PDFs (no OCR).
 */
async function extractPDFText(fileContent: any): Promise<string | null> {
  // Dynamic import because pdf-parse has side effects on load
  const pdfParse = require('pdf-parse');

  let buffer: Buffer;

  if (typeof fileContent === 'string') {
    // Local file path
    buffer = fs.readFileSync(fileContent);
  } else if (Buffer.isBuffer(fileContent)) {
    buffer = fileContent;
  } else {
    // Readable stream - read into buffer
    buffer = await streamToBuffer(fileContent);
  }

  const data = await pdfParse(buffer, {
    // Limit to first 100 pages for performance
    max: 100,
  });

  const text = data.text?.trim();

  // If the PDF is scanned (image-based), pdf-parse returns very little text
  // We could add OCR here but haven't gotten to it
  if (text && text.length < 50) {
    // Probably a scanned document
    return null;
  }

  return text || null;
}

/**
 * Generate a thumbnail for images and PDFs.
 * Uses Sharp for image processing.
 */
async function generateThumbnail(
  fileContent: any,
  mimeType: string,
  documentId: string,
  bucket?: string,
): Promise<string | null> {
  const sharp = require('sharp');

  let inputBuffer: Buffer;

  if (typeof fileContent === 'string') {
    inputBuffer = fs.readFileSync(fileContent);
  } else if (Buffer.isBuffer(fileContent)) {
    inputBuffer = fileContent;
  } else {
    inputBuffer = await streamToBuffer(fileContent);
  }

  // For PDFs, we'd need to render the first page to an image first
  // Sharp can't handle PDFs directly
  if (mimeType === 'application/pdf') {
    // TODO: use pdf2image or poppler to render first page
    // For now skip thumbnail for PDFs
    return null;
  }

  try {
    const thumbnailBuffer = await sharp(inputBuffer)
      .resize(300, 300, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 80,
        progressive: true,
      })
      .toBuffer();

    // Store thumbnail
    const thumbnailKey = `thumbnails/${documentId}.jpg`;
    const { uploadFile } = require('./storageService');

    // Write thumbnail to temp file first (uploadFile expects a path)
    const tempPath = `/tmp/${documentId}-thumb.jpg`;
    fs.writeFileSync(tempPath, thumbnailBuffer);

    try {
      await uploadFile(thumbnailKey, tempPath, 'image/jpeg', bucket);
    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tempPath); } catch { }
    }

    return thumbnailKey;
  } catch (err: any) {
    getLogger().warn('Sharp thumbnail generation failed', {
      documentId,
      mimeType,
      error: err.message,
    });
    return null;
  }
}

function isImageType(mimeType: string): boolean {
  return mimeType.startsWith('image/') && mimeType !== 'image/dicom';
}

async function getFileAsString(fileContent: any): Promise<string> {
  if (typeof fileContent === 'string') {
    return fs.readFileSync(fileContent, 'utf-8');
  } else if (Buffer.isBuffer(fileContent)) {
    return fileContent.toString('utf-8');
  } else {
    const buffer = await streamToBuffer(fileContent);
    return buffer.toString('utf-8');
  }
}

function streamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
