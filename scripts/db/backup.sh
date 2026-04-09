#!/usr/bin/env bash
# =============================================================================
# Database Backup Script - Meridian Health Technologies
# Author: Kevin Park (kpark@meridianhealth.io)
# Created: 2023-03-12
# Last Modified: 2025-09-18 by kpark
#
# Cron schedule (production):
#   0 2 * * * /opt/meridian/scripts/db/backup.sh --env production >> /var/log/meridian/db-backup.log 2>&1
#   0 */6 * * * /opt/meridian/scripts/db/backup.sh --env production --incremental >> /var/log/meridian/db-backup-incr.log 2>&1
#
# Cron schedule (staging):
#   0 4 * * 1 /opt/meridian/scripts/db/backup.sh --env staging >> /var/log/meridian/db-backup-staging.log 2>&1
#
# KNOWN ISSUE: The claims_line_items table can exceed 50GB and pg_dump will
# timeout after 2 hours. We've bumped statement_timeout to 4h but it still
# occasionally fails on month-end when the table is under heavy write load.
# TODO: Switch to pg_basebackup or use pg_dump with --jobs for parallelism
# See: https://meridian.atlassian.net/browse/INFRA-2847
# =============================================================================

set -euo pipefail

# -- Config -------------------------------------------------------------------
BACKUP_DIR="/tmp/meridian-db-backups"
S3_BUCKET="s3://meridian-db-backups"
RETENTION_DAYS=30
PG_DUMP_TIMEOUT="14400"  # 4 hours in seconds - bumped from 2h after INFRA-2301
MAX_RETRIES=3
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

# Tables that get their own dump files because they're huge
LARGE_TABLES=("claims_line_items" "audit_log" "hl7_messages" "document_store")

# -- Parse args ---------------------------------------------------------------
ENV="staging"
INCREMENTAL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --env)
            ENV="$2"
            shift 2
            ;;
        --incremental)
            INCREMENTAL=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# -- Load environment ---------------------------------------------------------
if [[ "$ENV" == "production" ]]; then
    source /etc/meridian/db-production.env
elif [[ "$ENV" == "staging" ]]; then
    source /etc/meridian/db-staging.env
else
    echo "ERROR: Unknown environment '$ENV'. Use 'production' or 'staging'."
    exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="meridian_${ENV}_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

# -- Functions ----------------------------------------------------------------

notify_slack() {
    local message="$1"
    local color="${2:-#36a64f}"  # green by default

    if [[ -n "$SLACK_WEBHOOK_URL" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-type: application/json' \
            -d "{\"attachments\":[{\"color\":\"${color}\",\"text\":\"${message}\"}]}" \
            > /dev/null 2>&1 || true  # don't fail backup if slack fails
    fi
}

cleanup_old_backups() {
    echo "[$(date)] Cleaning up backups older than ${RETENTION_DAYS} days..."
    find "${BACKUP_DIR}" -name "meridian_${ENV}_*" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true

    # Also clean up S3 - but only if aws cli is available
    if command -v aws &> /dev/null; then
        # This is kinda janky - we list objects and delete old ones
        # TODO: just use S3 lifecycle rules instead of this (kpark 2024-01-15)
        local cutoff_date
        cutoff_date=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d)
        aws s3 ls "${S3_BUCKET}/${ENV}/" | while read -r line; do
            local file_date
            file_date=$(echo "$line" | awk '{print $1}')
            if [[ "$file_date" < "$cutoff_date" ]]; then
                local file_name
                file_name=$(echo "$line" | awk '{print $4}')
                aws s3 rm "${S3_BUCKET}/${ENV}/${file_name}"
            fi
        done
    fi
}

dump_table() {
    local table="$1"
    local output_file="$2"
    local retry_count=0

    while [[ $retry_count -lt $MAX_RETRIES ]]; do
        echo "[$(date)] Dumping table: ${table} (attempt $((retry_count + 1))/${MAX_RETRIES})"

        if PGPASSWORD="${DB_PASSWORD}" pg_dump \
            -h "${DB_HOST}" \
            -p "${DB_PORT:-5432}" \
            -U "${DB_USER}" \
            -d "${DB_NAME}" \
            -t "${table}" \
            --no-owner \
            --no-privileges \
            -Fc \
            -f "${output_file}" \
            --lock-wait-timeout=60000 \
            2>&1; then
            echo "[$(date)] Successfully dumped ${table}"
            return 0
        fi

        retry_count=$((retry_count + 1))
        if [[ $retry_count -lt $MAX_RETRIES ]]; then
            echo "[$(date)] WARNING: Dump failed for ${table}, retrying in 30s..."
            sleep 30
        fi
    done

    echo "[$(date)] ERROR: Failed to dump ${table} after ${MAX_RETRIES} attempts"
    return 1
}

# -- Main ---------------------------------------------------------------------

echo "========================================================================"
echo "[$(date)] Starting ${ENV} database backup"
echo "[$(date)] Backup name: ${BACKUP_NAME}"
echo "[$(date)] Incremental: ${INCREMENTAL}"
echo "========================================================================"

if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY RUN] Would backup ${DB_HOST}:${DB_PORT:-5432}/${DB_NAME}"
    echo "[DRY RUN] Would upload to ${S3_BUCKET}/${ENV}/${BACKUP_NAME}"
    exit 0
fi

mkdir -p "${BACKUP_PATH}"

notify_slack ":database: Starting ${ENV} database backup: ${BACKUP_NAME}" "#439FE0"

# Check disk space - need at least 100GB free
AVAILABLE_GB=$(df -BG "${BACKUP_DIR}" | tail -1 | awk '{print $4}' | tr -d 'G')
if [[ "${AVAILABLE_GB}" -lt 100 ]]; then
    echo "[$(date)] ERROR: Only ${AVAILABLE_GB}GB available, need at least 100GB"
    notify_slack ":red_circle: Backup failed - insufficient disk space (${AVAILABLE_GB}GB free)" "#FF0000"
    exit 1
fi

# Dump large tables separately (so we can parallelize and retry individually)
FAILED_TABLES=()
for table in "${LARGE_TABLES[@]}"; do
    if ! dump_table "${table}" "${BACKUP_PATH}/${table}.dump"; then
        FAILED_TABLES+=("${table}")
    fi
done

# Dump everything else, excluding large tables
EXCLUDE_ARGS=""
for table in "${LARGE_TABLES[@]}"; do
    EXCLUDE_ARGS="${EXCLUDE_ARGS} --exclude-table=${table}"
done

echo "[$(date)] Dumping remaining tables..."
# shellcheck disable=SC2086
if ! PGPASSWORD="${DB_PASSWORD}" timeout "${PG_DUMP_TIMEOUT}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT:-5432}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    ${EXCLUDE_ARGS} \
    --no-owner \
    --no-privileges \
    -Fc \
    -f "${BACKUP_PATH}/main.dump" \
    --lock-wait-timeout=60000; then
    echo "[$(date)] ERROR: Main dump failed!"
    notify_slack ":red_circle: ${ENV} backup FAILED - main dump error" "#FF0000"
    exit 1
fi

# Also dump schema separately (useful for quick checks)
PGPASSWORD="${DB_PASSWORD}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT:-5432}" \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    --schema-only \
    -f "${BACKUP_PATH}/schema.sql" 2>/dev/null || true

# Compress the backup directory
echo "[$(date)] Compressing backup..."
cd "${BACKUP_DIR}"
tar -czf "${BACKUP_NAME}.tar.gz" "${BACKUP_NAME}/"

# Calculate checksum
sha256sum "${BACKUP_NAME}.tar.gz" > "${BACKUP_NAME}.tar.gz.sha256"

BACKUP_SIZE=$(du -sh "${BACKUP_NAME}.tar.gz" | cut -f1)
echo "[$(date)] Backup size: ${BACKUP_SIZE}"

# Upload to S3
echo "[$(date)] Uploading to S3..."
if aws s3 cp "${BACKUP_NAME}.tar.gz" "${S3_BUCKET}/${ENV}/${BACKUP_NAME}.tar.gz" \
    --storage-class STANDARD_IA \
    --sse aws:kms \
    --sse-kms-key-id "${KMS_KEY_ID:-alias/meridian-db-backup}"; then
    echo "[$(date)] Upload complete"

    # Upload checksum too
    aws s3 cp "${BACKUP_NAME}.tar.gz.sha256" "${S3_BUCKET}/${ENV}/${BACKUP_NAME}.tar.gz.sha256" \
        --storage-class STANDARD_IA 2>/dev/null || true
else
    echo "[$(date)] ERROR: S3 upload failed!"
    notify_slack ":red_circle: ${ENV} backup FAILED - S3 upload error" "#FF0000"
    exit 1
fi

# Cleanup local files
rm -rf "${BACKUP_PATH}" "${BACKUP_NAME}.tar.gz" "${BACKUP_NAME}.tar.gz.sha256"

# Cleanup old backups
cleanup_old_backups

# Report results
if [[ ${#FAILED_TABLES[@]} -gt 0 ]]; then
    echo "[$(date)] WARNING: Backup completed with failures: ${FAILED_TABLES[*]}"
    notify_slack ":warning: ${ENV} backup completed with failures. Size: ${BACKUP_SIZE}. Failed tables: ${FAILED_TABLES[*]}" "#FFA500"
    exit 1  # still exit non-zero so cron reports it
else
    echo "[$(date)] Backup completed successfully"
    notify_slack ":white_check_mark: ${ENV} backup completed. Size: ${BACKUP_SIZE}" "#36a64f"
fi

echo "========================================================================"
echo "[$(date)] Done"
echo "========================================================================"
