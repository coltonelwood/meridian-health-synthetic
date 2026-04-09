import { Client as MinioClient } from 'minio';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

const getLogger = () => (global as any).__logger;

/**
 * Storage Service
 *
 * Abstraction layer over file storage backends.
 * Currently supports:
 * - MinIO (S3-compatible) - primary/production
 * - Local filesystem - fallback / legacy
 * - AWS S3 (via MinIO client with AWS endpoint) - planned
 *
 * We started with local filesystem storage because MinIO wasn't set up
 * in our first environment. Then we added MinIO. Then some environments
 * still used local storage. So now we support both and it's a mess.
 *
 * The storage backend is determined by:
 * 1. STORAGE_BACKEND env var ('minio', 'local', 's3')
 * 2. Each document record has its own storage_backend field because
 *    we migrated from local to MinIO over time, so old documents
 *    are still on local storage.
 *
 * Known issues:
 * - The migration script (scripts/migrate-local-to-minio.ts) has been
 *   run partially. About 15% of documents are still on local storage.
 * - When MinIO is down, uploads fall back to local storage but we don't
 *   automatically migrate them back when MinIO comes back up.
 * - File paths on local storage use the patient_id in the path, which
 *   technically means someone with filesystem access could browse by
 *   patient. MinIO keys are randomized UUIDs. The local path structure
 *   predates our security review.
 */

// MinIO client (lazy initialization)
let minioClient: MinioClient | null = null;

function getMinioClient(): MinioClient {
  if (!minioClient) {
    minioClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: parseInt(process.env.MINIO_PORT || '9000'),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
      // region: process.env.MINIO_REGION || 'us-east-1',
    });
  }
  return minioClient;
}

const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH || '/var/meridian/documents';

/**
 * Upload a file to storage.
 *
 * @param storageKey - The key/path to store the file under
 * @param filePath - Local path of the file to upload (from multer temp dir)
 * @param contentType - MIME type
 * @param bucket - MinIO bucket name
 */
export async function uploadFile(
  storageKey: string,
  filePath: string,
  contentType: string,
  bucket?: string,
): Promise<{ backend: string; key: string }> {
  const logger = getLogger();
  const backend = process.env.STORAGE_BACKEND || 'minio';

  if (backend === 'minio' || backend === 's3') {
    try {
      const client = getMinioClient();
      const targetBucket = bucket || process.env.MINIO_BUCKET || 'clinical-documents';

      // Ensure bucket exists
      const bucketExists = await client.bucketExists(targetBucket);
      if (!bucketExists) {
        await client.makeBucket(targetBucket, process.env.MINIO_REGION || 'us-east-1');
        logger.info('Created MinIO bucket', { bucket: targetBucket });
      }

      // Upload file
      const fileStream = fs.createReadStream(filePath);
      const fileStats = fs.statSync(filePath);

      await client.putObject(
        targetBucket,
        storageKey,
        fileStream,
        fileStats.size,
        { 'Content-Type': contentType }
      );

      logger.debug('File uploaded to MinIO', {
        bucket: targetBucket,
        key: storageKey,
        size: fileStats.size,
      });

      return { backend: 'minio', key: storageKey };
    } catch (err: any) {
      logger.error('MinIO upload failed', { error: err.message, key: storageKey });
      // Fall through to local storage
      logger.warn('Falling back to local filesystem storage');
    }
  }

  // Local filesystem fallback
  const localPath = path.join(LOCAL_STORAGE_PATH, storageKey);
  const localDir = path.dirname(localPath);

  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  fs.copyFileSync(filePath, localPath);

  logger.debug('File stored locally', { path: localPath });

  return { backend: 'local', key: storageKey };
}

/**
 * Download a file from storage.
 * Returns either a readable stream (MinIO) or a file path (local).
 * Yeah, the inconsistent return type is bad. We should fix this.
 */
export async function downloadFile(
  backend: string,
  storageKey: string,
  bucket?: string,
): Promise<Readable | string> {
  const logger = getLogger();

  if (backend === 'minio' || backend === 's3') {
    const client = getMinioClient();
    const targetBucket = bucket || process.env.MINIO_BUCKET || 'clinical-documents';

    try {
      const stream = await client.getObject(targetBucket, storageKey);
      return stream;
    } catch (err: any) {
      logger.error('Failed to download from MinIO', {
        bucket: targetBucket,
        key: storageKey,
        error: err.message,
      });

      // Try local fallback (maybe the file was never migrated)
      const localPath = path.join(LOCAL_STORAGE_PATH, storageKey);
      if (fs.existsSync(localPath)) {
        logger.warn('File not in MinIO but found locally', { key: storageKey });
        return localPath;
      }

      throw new Error(`File not found in any storage backend: ${storageKey}`);
    }
  }

  // Local filesystem
  const localPath = path.join(LOCAL_STORAGE_PATH, storageKey);
  if (!fs.existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  return localPath;
}

/**
 * Delete a file from storage.
 * Note: We typically DON'T call this - documents are soft-deleted
 * in the database and the actual files are retained for compliance.
 * This function is used by the cleanup script for truly purging
 * files after the retention period.
 */
export async function deleteFile(
  backend: string,
  storageKey: string,
  bucket?: string,
): Promise<void> {
  const logger = getLogger();

  if (backend === 'minio' || backend === 's3') {
    const client = getMinioClient();
    const targetBucket = bucket || process.env.MINIO_BUCKET || 'clinical-documents';

    try {
      await client.removeObject(targetBucket, storageKey);
      logger.info('File deleted from MinIO', { bucket: targetBucket, key: storageKey });
    } catch (err: any) {
      logger.error('Failed to delete from MinIO', { error: err.message, key: storageKey });
      throw err;
    }
  } else {
    const localPath = path.join(LOCAL_STORAGE_PATH, storageKey);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
      logger.info('File deleted from local storage', { path: localPath });
    }
  }
}

/**
 * Generate a pre-signed URL for direct download.
 * Only works with MinIO/S3, not local storage.
 */
export async function getPresignedUrl(
  storageKey: string,
  bucket?: string,
  expirySeconds: number = 3600,
): Promise<string | null> {
  const logger = getLogger();

  try {
    const client = getMinioClient();
    const targetBucket = bucket || process.env.MINIO_BUCKET || 'clinical-documents';

    const url = await client.presignedGetObject(targetBucket, storageKey, expirySeconds);
    return url;
  } catch (err: any) {
    logger.error('Failed to generate presigned URL', {
      error: err.message,
      key: storageKey,
    });
    return null;
  }
}

/**
 * Check if a file exists in storage.
 */
export async function fileExists(
  backend: string,
  storageKey: string,
  bucket?: string,
): Promise<boolean> {
  if (backend === 'minio' || backend === 's3') {
    try {
      const client = getMinioClient();
      const targetBucket = bucket || process.env.MINIO_BUCKET || 'clinical-documents';
      await client.statObject(targetBucket, storageKey);
      return true;
    } catch {
      return false;
    }
  }

  const localPath = path.join(LOCAL_STORAGE_PATH, storageKey);
  return fs.existsSync(localPath);
}
