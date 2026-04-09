#!/usr/bin/env bash
# =============================================================================
# Database Restore Script - Meridian Health Technologies
# Author: Kevin Park (kpark@meridianhealth.io)
# Created: 2023-03-14
# Last Modified: 2025-06-02 by ajiang
#
# DANGER: This script can destroy data. Read carefully before running.
#
# Usage:
#   ./restore.sh --env staging --backup meridian_staging_20250601_020000.tar.gz
#   ./restore.sh --env staging --backup s3://meridian-db-backups/staging/meridian_staging_20250601_020000.tar.gz
#   ./restore.sh --env production --backup <file> --confirm-production
#
# After the incident on 2024-04-22 where someone accidentally restored a
# staging backup to production (INC-1847), we added the --confirm-production
# flag. DO NOT remove it.
# =============================================================================

set -euo pipefail

# -- Parse args ---------------------------------------------------------------
ENV=""
BACKUP_FILE=""
CONFIRM_PRODUCTION=false
SKIP_VERIFICATION=false
TARGET_TABLES=""  # empty = all tables

while [[ $# -gt 0 ]]; do
    case $1 in
        --env)
            ENV="$2"
            shift 2
            ;;
        --backup)
            BACKUP_FILE="$2"
            shift 2
            ;;
        --confirm-production)
            CONFIRM_PRODUCTION=true
            shift
            ;;
        --skip-verification)
            SKIP_VERIFICATION=true
            shift
            ;;
        --tables)
            TARGET_TABLES="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# -- Validation ---------------------------------------------------------------

if [[ -z "$ENV" ]]; then
    echo "ERROR: --env is required (staging or production)"
    exit 1
fi

if [[ -z "$BACKUP_FILE" ]]; then
    echo "ERROR: --backup is required"
    exit 1
fi

# Production safety checks
if [[ "$ENV" == "production" ]]; then
    if [[ "$CONFIRM_PRODUCTION" != "true" ]]; then
        echo ""
        echo "  ============================================================"
        echo "  WARNING: You are about to restore to PRODUCTION!"
        echo "  ============================================================"
        echo ""
        echo "  This will DESTROY existing data in the production database."
        echo "  If you are sure, re-run with --confirm-production flag."
        echo ""
        echo "  If you meant to restore to staging, use --env staging"
        echo ""
        exit 1
    fi

    # Double check - prompt for confirmation
    # NOTE(ajiang 2025-06-02): Commenting this out because it breaks automation.
    # We rely on --confirm-production flag now. If someone passes that flag
    # they know what they're doing... probably.
    #
    # echo "Type 'RESTORE PRODUCTION' to confirm:"
    # read -r confirmation
    # if [[ "$confirmation" != "RESTORE PRODUCTION" ]]; then
    #     echo "Aborted."
    #     exit 1
    # fi

    # Check that we're not restoring a staging backup to production
    if echo "$BACKUP_FILE" | grep -q "staging"; then
        echo "ERROR: Refusing to restore a staging backup to production."
        echo "The backup filename contains 'staging'. This is almost certainly wrong."
        echo "If you really want to do this, rename the file first."
        exit 1
    fi
fi

# -- Load environment ---------------------------------------------------------

if [[ "$ENV" == "production" ]]; then
    source /etc/meridian/db-production.env
elif [[ "$ENV" == "staging" ]]; then
    source /etc/meridian/db-staging.env
else
    echo "ERROR: Unknown environment '$ENV'"
    exit 1
fi

RESTORE_DIR="/tmp/meridian-db-restore-$$"
mkdir -p "${RESTORE_DIR}"

# -- Download from S3 if needed ----------------------------------------------

if [[ "$BACKUP_FILE" == s3://* ]]; then
    echo "[$(date)] Downloading backup from S3..."
    LOCAL_BACKUP="${RESTORE_DIR}/$(basename "$BACKUP_FILE")"
    aws s3 cp "$BACKUP_FILE" "$LOCAL_BACKUP"

    # Verify checksum if available
    CHECKSUM_FILE="${BACKUP_FILE}.sha256"
    if aws s3 ls "$CHECKSUM_FILE" &>/dev/null; then
        aws s3 cp "$CHECKSUM_FILE" "${LOCAL_BACKUP}.sha256"
        echo "[$(date)] Verifying checksum..."
        cd "${RESTORE_DIR}"
        if ! sha256sum -c "$(basename "$LOCAL_BACKUP").sha256"; then
            echo "ERROR: Checksum verification failed!"
            rm -rf "${RESTORE_DIR}"
            exit 1
        fi
    else
        echo "[$(date)] WARNING: No checksum file found, skipping verification"
    fi
    BACKUP_FILE="$LOCAL_BACKUP"
fi

# -- Extract ------------------------------------------------------------------

echo "[$(date)] Extracting backup..."
cd "${RESTORE_DIR}"
tar -xzf "${BACKUP_FILE}"

# Find the extracted directory
BACKUP_DIR=$(find "${RESTORE_DIR}" -maxdepth 1 -type d -name "meridian_*" | head -1)
if [[ -z "$BACKUP_DIR" ]]; then
    echo "ERROR: Could not find backup directory after extraction"
    rm -rf "${RESTORE_DIR}"
    exit 1
fi

echo "[$(date)] Backup directory: ${BACKUP_DIR}"
echo "[$(date)] Contents:"
ls -lh "${BACKUP_DIR}/"

# -- Pre-restore checks -------------------------------------------------------

if [[ "$SKIP_VERIFICATION" != "true" ]]; then
    echo "[$(date)] Running pre-restore checks..."

    # Check we can connect
    if ! PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" \
        -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1" &>/dev/null; then
        echo "ERROR: Cannot connect to database"
        rm -rf "${RESTORE_DIR}"
        exit 1
    fi

    # Check active connections
    ACTIVE_CONNS=$(PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" \
        -U "${DB_USER}" -d "${DB_NAME}" -t -c \
        "SELECT count(*) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid != pg_backend_pid()")
    ACTIVE_CONNS=$(echo "$ACTIVE_CONNS" | tr -d ' ')

    if [[ "$ACTIVE_CONNS" -gt 5 ]]; then
        echo "WARNING: There are ${ACTIVE_CONNS} active connections to the database."
        echo "Consider draining connections before restoring."
        if [[ "$ENV" == "production" ]]; then
            echo "ERROR: Too many active connections for production restore. Drain first."
            rm -rf "${RESTORE_DIR}"
            exit 1
        fi
    fi
fi

# -- Restore ------------------------------------------------------------------

echo ""
echo "========================================================================"
echo "[$(date)] RESTORING to ${ENV}: ${DB_HOST}:${DB_PORT:-5432}/${DB_NAME}"
echo "========================================================================"
echo ""

# Restore main dump
if [[ -f "${BACKUP_DIR}/main.dump" ]]; then
    echo "[$(date)] Restoring main dump..."
    PGPASSWORD="${DB_PASSWORD}" pg_restore \
        -h "${DB_HOST}" \
        -p "${DB_PORT:-5432}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --clean \
        --if-exists \
        --no-owner \
        --no-privileges \
        --single-transaction \
        "${BACKUP_DIR}/main.dump" 2>&1 | tee "${RESTORE_DIR}/restore-main.log"
    echo "[$(date)] Main dump restored"
fi

# Restore individual large tables
for dump_file in "${BACKUP_DIR}"/*.dump; do
    if [[ "$(basename "$dump_file")" == "main.dump" ]]; then
        continue
    fi

    table_name=$(basename "$dump_file" .dump)

    # If we're only restoring specific tables, skip non-matching ones
    if [[ -n "$TARGET_TABLES" ]] && ! echo "$TARGET_TABLES" | grep -q "$table_name"; then
        echo "[$(date)] Skipping ${table_name} (not in target tables)"
        continue
    fi

    echo "[$(date)] Restoring table: ${table_name}..."
    PGPASSWORD="${DB_PASSWORD}" pg_restore \
        -h "${DB_HOST}" \
        -p "${DB_PORT:-5432}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --clean \
        --if-exists \
        --no-owner \
        --no-privileges \
        --single-transaction \
        "$dump_file" 2>&1 | tee "${RESTORE_DIR}/restore-${table_name}.log"
done

# -- Post-restore -------------------------------------------------------------

echo "[$(date)] Running ANALYZE on restored tables..."
PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" \
    -U "${DB_USER}" -d "${DB_NAME}" -c "ANALYZE"

# Quick sanity check
echo "[$(date)] Post-restore sanity check..."
PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT:-5432}" \
    -U "${DB_USER}" -d "${DB_NAME}" <<'SQL'
SELECT 'patients' as table_name, count(*) as row_count FROM patients
UNION ALL
SELECT 'providers', count(*) FROM providers
UNION ALL
SELECT 'claims', count(*) FROM claims
UNION ALL
SELECT 'appointments', count(*) FROM appointments
ORDER BY table_name;
SQL

# Cleanup
rm -rf "${RESTORE_DIR}"

echo ""
echo "========================================================================"
echo "[$(date)] Restore complete!"
echo "========================================================================"
echo ""
echo "IMPORTANT: Please verify the application is working correctly."
echo "Check: https://grafana.meridianhealth.io/d/db-health"
