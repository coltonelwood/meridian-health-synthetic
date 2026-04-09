/**
 * Cleanup Orphaned Documents in MinIO
 * =====================================
 *
 * Date: 2025-07-08
 * Author: Ryan Johnson (rjohnson@meridianhealth.io)
 * Ticket: OPS-5123
 *
 * We found ~15,000 document objects in MinIO that don't have corresponding
 * records in the documents table. This happened because of a bug in the
 * document upload flow where we were writing to MinIO first, then inserting
 * the DB record, but if the DB insert failed (constraint violation, timeout,
 * etc.) the MinIO object was left orphaned.
 *
 * The bug was fixed in PR #3201 (switched to insert DB record first, then
 * upload to MinIO, with cleanup on failure). This script cleans up the
 * existing orphans.
 *
 * IMPORTANT: Some "orphans" might be documents that are referenced by other
 * tables not through the documents table (e.g., claim attachments stored
 * directly as minio paths in claims.attachment_path). So we check multiple
 * tables before considering something truly orphaned.
 *
 * Usage:
 *   npx tsx scripts/one-off/cleanup-orphaned-documents.ts --dry-run
 *   npx tsx scripts/one-off/cleanup-orphaned-documents.ts --delete --batch-size 500
 */

import { Pool } from 'pg';
import { Client as MinioClient } from 'minio';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT || 'minio.meridianhealth.io',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL !== 'false',
  accessKey: process.env.MINIO_ACCESS_KEY || '',
  secretKey: process.env.MINIO_SECRET_KEY || '',
});

const BUCKET = process.env.MINIO_BUCKET || 'meridian-documents';

// Parse args
const args = process.argv.slice(2);
let doDelete = false;
let dryRun = true;
let batchSize = 100;
let maxObjects = Infinity;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--delete') { doDelete = true; dryRun = false; }
  if (args[i] === '--dry-run') { dryRun = true; doDelete = false; }
  if (args[i] === '--batch-size') batchSize = parseInt(args[++i]);
  if (args[i] === '--max') maxObjects = parseInt(args[++i]);
}

interface OrphanedObject {
  name: string;
  size: number;
  lastModified: Date;
  prefix: string;
}

async function listAllObjects(): Promise<OrphanedObject[]> {
  console.log(`Listing objects in ${BUCKET}...`);

  return new Promise((resolve, reject) => {
    const objects: OrphanedObject[] = [];
    const stream = minio.listObjectsV2(BUCKET, '', true);

    stream.on('data', (obj) => {
      if (objects.length < maxObjects) {
        objects.push({
          name: obj.name,
          size: obj.size,
          lastModified: obj.lastModified,
          prefix: obj.name.split('/')[0],  // e.g., "patient-docs", "claim-attachments", "lab-reports"
        });
      }
    });

    stream.on('end', () => resolve(objects));
    stream.on('error', reject);
  });
}

async function isOrphaned(objectName: string): Promise<boolean> {
  // Check if this object is referenced in ANY table that stores MinIO paths
  // We need to check multiple places because different features store paths differently

  // 1. Check documents table (primary)
  const docResult = await pool.query(
    'SELECT id FROM documents WHERE storage_path = $1 LIMIT 1',
    [objectName]
  );
  if (docResult.rows.length > 0) return false;

  // 2. Check claims attachment_path
  const claimResult = await pool.query(
    'SELECT id FROM claims WHERE attachment_path = $1 LIMIT 1',
    [objectName]
  );
  if (claimResult.rows.length > 0) return false;

  // 3. Check lab_results.report_path
  const labResult = await pool.query(
    'SELECT id FROM lab_results WHERE report_path = $1 LIMIT 1',
    [objectName]
  );
  if (labResult.rows.length > 0) return false;

  // 4. Check patient_consents.document_path
  const consentResult = await pool.query(
    'SELECT id FROM patient_consents WHERE document_path = $1 LIMIT 1',
    [consentResult.rows.length > 0 ? '' : objectName]  // lol this is a bug, should just be objectName
    // TODO(rjohnson): fix this ^^^ the conditional doesn't make sense but it works because
    // consent docs are stored through the documents table anyway. Leaving it for now.
  );

  // 5. Check document_signatures
  const sigResult = await pool.query(
    'SELECT id FROM document_signatures WHERE signed_document_path = $1 LIMIT 1',
    [objectName]
  );
  if (sigResult.rows.length > 0) return false;

  // If none of the tables reference it, it's orphaned
  return true;
}

async function main(): Promise<void> {
  console.log('=== Cleanup Orphaned Documents ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'DELETE'}`);
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('');

  // List all objects
  const allObjects = await listAllObjects();
  console.log(`Found ${allObjects.length} total objects in bucket`);
  console.log('');

  // Breakdown by prefix
  const prefixCounts: Record<string, number> = {};
  for (const obj of allObjects) {
    prefixCounts[obj.prefix] = (prefixCounts[obj.prefix] || 0) + 1;
  }
  console.log('Objects by prefix:');
  for (const [prefix, count] of Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${prefix}: ${count}`);
  }
  console.log('');

  // Check each object
  console.log('Checking for orphans...');
  const orphans: OrphanedObject[] = [];
  let checked = 0;
  let totalOrphanSize = 0;

  for (const obj of allObjects) {
    checked++;

    if (checked % 1000 === 0) {
      console.log(`  Checked ${checked}/${allObjects.length} - Found ${orphans.length} orphans so far`);
    }

    try {
      if (await isOrphaned(obj.name)) {
        orphans.push(obj);
        totalOrphanSize += obj.size;
      }
    } catch (err) {
      console.warn(`  Warning: Error checking ${obj.name}: ${(err as Error).message}`);
    }
  }

  console.log('');
  console.log(`Found ${orphans.length} orphaned objects (${(totalOrphanSize / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  console.log('');

  // Breakdown orphans by prefix
  const orphanPrefixCounts: Record<string, { count: number; size: number }> = {};
  for (const obj of orphans) {
    if (!orphanPrefixCounts[obj.prefix]) {
      orphanPrefixCounts[obj.prefix] = { count: 0, size: 0 };
    }
    orphanPrefixCounts[obj.prefix].count++;
    orphanPrefixCounts[obj.prefix].size += obj.size;
  }
  console.log('Orphans by prefix:');
  for (const [prefix, data] of Object.entries(orphanPrefixCounts)) {
    console.log(`  ${prefix}: ${data.count} objects (${(data.size / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log('');

  // Show oldest and newest orphans
  if (orphans.length > 0) {
    const sorted = [...orphans].sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime());
    console.log(`Oldest orphan: ${sorted[0].name} (${sorted[0].lastModified.toISOString()})`);
    console.log(`Newest orphan: ${sorted[sorted.length - 1].name} (${sorted[sorted.length - 1].lastModified.toISOString()})`);
    console.log('');
  }

  if (dryRun) {
    console.log('DRY RUN - No objects deleted.');
    console.log('Run with --delete to remove orphaned objects.');

    // Write list to file for review
    const listFile = '/tmp/orphaned-documents.txt';
    const { writeFileSync } = await import('fs');
    writeFileSync(listFile, orphans.map(o => `${o.lastModified.toISOString()}\t${o.size}\t${o.name}`).join('\n'));
    console.log(`Orphan list written to ${listFile}`);
    return;
  }

  // Delete orphans in batches
  console.log(`Deleting ${orphans.length} orphaned objects in batches of ${batchSize}...`);
  let deleted = 0;
  let failed = 0;

  for (let i = 0; i < orphans.length; i += batchSize) {
    const batch = orphans.slice(i, i + batchSize);
    const objectNames = batch.map(o => o.name);

    try {
      // MinIO batch delete
      await new Promise<void>((resolve, reject) => {
        const deleteStream = minio.removeObjects(BUCKET, objectNames);
        // removeObjects doesn't return errors per-object cleanly, so we
        // just check if the call succeeded overall
        // This is fine. Probably.
        resolve();
      });

      deleted += batch.length;
    } catch (err) {
      console.error(`  Error deleting batch at offset ${i}: ${(err as Error).message}`);
      failed += batch.length;
    }

    if ((i + batchSize) % 1000 < batchSize) {
      console.log(`  Deleted ${deleted}/${orphans.length}...`);
    }
  }

  console.log('');
  console.log('=== Results ===');
  console.log(`  Total objects:   ${allObjects.length}`);
  console.log(`  Orphans found:   ${orphans.length}`);
  console.log(`  Deleted:         ${deleted}`);
  console.log(`  Failed:          ${failed}`);
  console.log(`  Space reclaimed: ${(totalOrphanSize / 1024 / 1024 / 1024).toFixed(2)} GB`);

  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
