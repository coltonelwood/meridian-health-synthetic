/**
 * Archive Old Documents to Cold Storage
 *
 * Moves documents older than 2 years to S3 Glacier for cost savings.
 * Maintains metadata in MongoDB for searchability. Documents can be
 * retrieved from Glacier with a 3-5 hour restore time.
 *
 * Retention policy:
 * - Hot storage (S3 Standard): 0-2 years
 * - Warm storage (S3 Standard-IA): 2-5 years
 * - Cold storage (S3 Glacier): 5-10 years
 * - Deletion: After 10 years (regulatory minimum)
 *
 * Schedule: 0 2 * * 6 (2 AM ET, Saturdays)
 * Timeout: 120 minutes
 * Owner: Platform Team
 */

import { CronJob } from '../lib/cron-job';
import { DocumentsRepository } from '../repositories/documents';
import { S3Client } from '../clients/s3';
import { AuditLogger } from '../lib/audit';
import { metrics } from '../lib/metrics';
import { logger } from '../lib/logger';
import { subYears, format } from 'date-fns';

const BATCH_SIZE = 50;
const HOT_TO_WARM_YEARS = 2;
const WARM_TO_COLD_YEARS = 5;
const DELETION_YEARS = 10;

const BUCKETS = {
  documents: process.env.S3_DOCUMENTS_BUCKET || 'meridian-documents-prod',
  archive: process.env.S3_ARCHIVE_BUCKET || 'meridian-archive-prod',
};

const job = new CronJob({
  name: 'archive-old-documents',
  schedule: '0 2 * * 6',
  timezone: 'America/New_York',
  timeout: 120 * 60 * 1000,
  retries: 1,
});

job.run(async (context) => {
  const docsRepo = new DocumentsRepository();
  const s3 = new S3Client();
  const audit = new AuditLogger('document-archival');
  const startTime = Date.now();

  const now = new Date();
  const warmCutoff = subYears(now, HOT_TO_WARM_YEARS);
  const coldCutoff = subYears(now, WARM_TO_COLD_YEARS);
  const deletionCutoff = subYears(now, DELETION_YEARS);

  const results = {
    movedToWarm: 0,
    movedToCold: 0,
    deleted: 0,
    errors: 0,
    bytesArchived: 0,
    bytesMoved: 0,
  };

  logger.info('Starting document archival process');
  logger.info(`Warm cutoff: ${format(warmCutoff, 'yyyy-MM-dd')}`);
  logger.info(`Cold cutoff: ${format(coldCutoff, 'yyyy-MM-dd')}`);
  logger.info(`Deletion cutoff: ${format(deletionCutoff, 'yyyy-MM-dd')}`);

  try {
    // Phase 1: Move from Standard to Standard-IA (2+ years old)
    logger.info('Phase 1: Moving documents to Standard-IA storage class');
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      const documents = await docsRepo.findByStorageClass({
        storageClass: 'STANDARD',
        createdBefore: warmCutoff,
        limit: BATCH_SIZE,
        cursor,
      });

      if (documents.length === 0) {
        hasMore = false;
        break;
      }

      for (const doc of documents) {
        try {
          // Change storage class via S3 copy-in-place
          await s3.changeStorageClass({
            bucket: BUCKETS.documents,
            key: doc.s3Key,
            storageClass: 'STANDARD_IA',
          });

          // Update metadata in MongoDB
          await docsRepo.updateStorageClass(doc.id, {
            storageClass: 'STANDARD_IA',
            archivedAt: now,
            archivedBy: 'cron:archive-old-documents',
          });

          results.movedToWarm++;
          results.bytesMoved += doc.fileSize || 0;

        } catch (error) {
          results.errors++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to move document ${doc.id} to Standard-IA: ${errorMessage}`);
        }
      }

      cursor = documents[documents.length - 1]?.id;
      if (documents.length < BATCH_SIZE) hasMore = false;
    }

    logger.info(`Phase 1 complete: ${results.movedToWarm} documents moved to Standard-IA`);

    // Phase 2: Move from Standard-IA to Glacier (5+ years old)
    logger.info('Phase 2: Moving documents to Glacier');
    hasMore = true;
    cursor = undefined;

    while (hasMore) {
      const documents = await docsRepo.findByStorageClass({
        storageClass: 'STANDARD_IA',
        createdBefore: coldCutoff,
        limit: BATCH_SIZE,
        cursor,
      });

      if (documents.length === 0) {
        hasMore = false;
        break;
      }

      for (const doc of documents) {
        try {
          // Copy to archive bucket with Glacier storage class
          await s3.copyObject({
            sourceBucket: BUCKETS.documents,
            sourceKey: doc.s3Key,
            destinationBucket: BUCKETS.archive,
            destinationKey: `glacier/${doc.s3Key}`,
            storageClass: 'GLACIER',
            serverSideEncryption: 'aws:kms',
          });

          // Delete from documents bucket
          await s3.deleteObject({
            bucket: BUCKETS.documents,
            key: doc.s3Key,
          });

          // Update metadata
          await docsRepo.updateStorageClass(doc.id, {
            storageClass: 'GLACIER',
            s3Bucket: BUCKETS.archive,
            s3Key: `glacier/${doc.s3Key}`,
            archivedAt: now,
            archivedBy: 'cron:archive-old-documents',
            restoreTimeHours: 5, // Glacier standard retrieval
          });

          results.movedToCold++;
          results.bytesArchived += doc.fileSize || 0;

          await audit.log({
            action: 'DOCUMENT_ARCHIVED',
            resourceType: 'document',
            resourceId: doc.id,
            patientId: doc.patientId,
            details: {
              previousStorage: 'STANDARD_IA',
              newStorage: 'GLACIER',
              fileSize: doc.fileSize,
              documentType: doc.documentType,
              originalCreatedAt: doc.createdAt,
            },
          });

        } catch (error) {
          results.errors++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to archive document ${doc.id} to Glacier: ${errorMessage}`);
        }
      }

      cursor = documents[documents.length - 1]?.id;
      if (documents.length < BATCH_SIZE) hasMore = false;
    }

    logger.info(`Phase 2 complete: ${results.movedToCold} documents moved to Glacier`);

    // Phase 3: Delete documents past retention period (10+ years)
    // IMPORTANT: This is a permanent deletion. We verify the retention
    // policy before proceeding and double-check with the document type.
    logger.info('Phase 3: Deleting documents past retention period');
    hasMore = true;
    cursor = undefined;

    while (hasMore) {
      const documents = await docsRepo.findByStorageClass({
        storageClass: 'GLACIER',
        createdBefore: deletionCutoff,
        limit: BATCH_SIZE,
        cursor,
      });

      if (documents.length === 0) {
        hasMore = false;
        break;
      }

      for (const doc of documents) {
        try {
          // Check if document type has a longer retention requirement
          const retentionYears = getRetentionYears(doc.documentType);
          const docAge = (now.getTime() - new Date(doc.createdAt).getTime()) / (365.25 * 24 * 60 * 60 * 1000);

          if (docAge < retentionYears) {
            logger.info(`Skipping ${doc.id}: ${doc.documentType} requires ${retentionYears}-year retention`);
            continue;
          }

          // Delete from Glacier
          await s3.deleteObject({
            bucket: BUCKETS.archive,
            key: doc.s3Key,
          });

          // Soft-delete the metadata (we keep metadata indefinitely)
          await docsRepo.softDelete(doc.id, {
            deletedAt: now,
            deletedBy: 'cron:archive-old-documents',
            deletionReason: 'retention_period_expired',
          });

          results.deleted++;

          await audit.log({
            action: 'DOCUMENT_DELETED',
            resourceType: 'document',
            resourceId: doc.id,
            patientId: doc.patientId,
            details: {
              documentType: doc.documentType,
              originalCreatedAt: doc.createdAt,
              retentionYears,
              reason: 'retention_period_expired',
            },
          });

        } catch (error) {
          results.errors++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to delete document ${doc.id}: ${errorMessage}`);
        }
      }

      cursor = documents[documents.length - 1]?.id;
      if (documents.length < BATCH_SIZE) hasMore = false;
    }

    logger.info(`Phase 3 complete: ${results.deleted} documents permanently deleted`);

    // Metrics
    const duration = Date.now() - startTime;
    metrics.gauge('cron.archival.moved_to_warm', results.movedToWarm);
    metrics.gauge('cron.archival.moved_to_cold', results.movedToCold);
    metrics.gauge('cron.archival.deleted', results.deleted);
    metrics.gauge('cron.archival.errors', results.errors);
    metrics.gauge('cron.archival.bytes_archived', results.bytesArchived);
    metrics.timing('cron.archival.duration', duration);

    logger.info(`Document archival complete in ${Math.round(duration / 1000)}s`, results);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Document archival failed: ${errorMessage}`);
    throw error;
  }
});

/**
 * Get the retention period for a document type.
 * Different document types may have different regulatory requirements.
 */
function getRetentionYears(documentType: string): number {
  const retentionPolicy: Record<string, number> = {
    'medical_record': 10,     // State law varies, using 10 years as safe default
    'lab_result': 10,
    'imaging': 10,
    'consent_form': 10,
    'insurance_card': 7,
    'referral': 7,
    'claim_attachment': 7,    // IRS requires 7 years for financial records
    'eob': 7,
    'statement': 7,
    'correspondence': 7,
    'hipaa_authorization': 6,  // HIPAA requires 6 years for admin records
    'audit_report': 6,
    'misc': 7,
  };

  return retentionPolicy[documentType] || 10; // Default to 10 years if unknown
}

export default job;
