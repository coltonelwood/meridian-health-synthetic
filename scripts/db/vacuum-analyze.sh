#!/usr/bin/env bash
# =============================================================================
# VACUUM ANALYZE - Meridian Health Technologies
# Author: Kevin Park (kpark@meridianhealth.io)
# Created: 2023-05-20
# Last Modified: 2025-11-10 by dholmes
#
# Runs VACUUM ANALYZE on frequently-updated tables. Full VACUUM on weekends.
#
# Cron schedule (production):
#   # Lightweight analyze on key tables every 4 hours during business hours
#   0 8,12,16,20 * * 1-5 /opt/meridian/scripts/db/vacuum-analyze.sh --mode analyze >> /var/log/meridian/vacuum.log 2>&1
#
#   # Full vacuum on Sunday at 1 AM when traffic is lowest
#   0 1 * * 0 /opt/meridian/scripts/db/vacuum-analyze.sh --mode full >> /var/log/meridian/vacuum-full.log 2>&1
#
#   # Regular vacuum daily at midnight
#   0 0 * * * /opt/meridian/scripts/db/vacuum-analyze.sh --mode vacuum >> /var/log/meridian/vacuum.log 2>&1
#
# NOTE(dholmes): After upgrading to PG 16, autovacuum should handle most of
# this, but the claims tables have such high churn that we still need manual
# vacuum to keep the planner happy. We tuned autovacuum_vacuum_scale_factor
# down to 0.01 for claims but it's still not aggressive enough during
# month-end billing runs.
# =============================================================================

set -euo pipefail

MODE="${1:---mode}"
if [[ "$MODE" == "--mode" ]]; then
    MODE="${2:-analyze}"
fi

# Tables ordered by priority (most frequently updated first)
CRITICAL_TABLES=(
    "claims"
    "claims_line_items"
    "claim_status_history"
    "appointments"
    "patient_encounters"
    "billing_transactions"
    "eligibility_checks"
)

# These tables are large but change less frequently
SECONDARY_TABLES=(
    "patients"
    "providers"
    "insurance_plans"
    "medications"
    "diagnoses"
    "documents"
    "audit_log"
)

source /etc/meridian/db-production.env

PSQL="PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT:-5432} -U ${DB_USER} -d ${DB_NAME}"

echo "========================================================================"
echo "[$(date)] Starting VACUUM ANALYZE - mode: ${MODE}"
echo "========================================================================"

run_on_table() {
    local table="$1"
    local operation="$2"
    local start_time
    start_time=$(date +%s)

    echo -n "[$(date)] ${operation} ${table}... "

    if eval "$PSQL" -c "${operation} ${table}" 2>&1; then
        local end_time
        end_time=$(date +%s)
        local duration=$((end_time - start_time))
        echo "done (${duration}s)"
    else
        echo "FAILED"
        return 1
    fi
}

case "$MODE" in
    analyze)
        # Just ANALYZE - fast, updates planner statistics
        for table in "${CRITICAL_TABLES[@]}"; do
            run_on_table "$table" "ANALYZE"
        done
        ;;

    vacuum)
        # Regular VACUUM + ANALYZE on critical tables
        for table in "${CRITICAL_TABLES[@]}"; do
            run_on_table "$table" "VACUUM ANALYZE"
        done
        # Just ANALYZE on secondary
        for table in "${SECONDARY_TABLES[@]}"; do
            run_on_table "$table" "ANALYZE"
        done
        ;;

    full)
        # VACUUM FULL - reclaims disk space but locks tables
        # Only run on weekends!
        DOW=$(date +%u)  # 1=Monday, 7=Sunday
        if [[ "$DOW" -lt 6 ]]; then
            echo "WARNING: VACUUM FULL should only run on weekends (Sat/Sun)"
            echo "Current day: $(date +%A)"
            echo "Override with: FORCE_FULL=1 $0 --mode full"
            if [[ "${FORCE_FULL:-0}" != "1" ]]; then
                exit 1
            fi
        fi

        echo "[$(date)] Running VACUUM FULL - tables will be locked!"
        echo "[$(date)] Estimated duration: 2-4 hours"

        for table in "${CRITICAL_TABLES[@]}" "${SECONDARY_TABLES[@]}"; do
            run_on_table "$table" "VACUUM (FULL, ANALYZE)"
        done

        # Also reindex after full vacuum
        echo "[$(date)] Reindexing..."
        eval "$PSQL" -c "REINDEX DATABASE ${DB_NAME}" 2>&1 || {
            echo "[$(date)] WARNING: REINDEX failed, but vacuum completed"
        }
        ;;

    *)
        echo "Unknown mode: ${MODE}"
        echo "Usage: $0 --mode [analyze|vacuum|full]"
        exit 1
        ;;
esac

# Print table stats for monitoring
echo ""
echo "[$(date)] Current table statistics:"
eval "$PSQL" -c "
    SELECT
        schemaname || '.' || relname AS table_name,
        n_live_tup AS live_rows,
        n_dead_tup AS dead_rows,
        CASE WHEN n_live_tup > 0
            THEN round(100.0 * n_dead_tup / n_live_tup, 1)
            ELSE 0
        END AS dead_pct,
        last_vacuum,
        last_autovacuum,
        last_analyze
    FROM pg_stat_user_tables
    WHERE relname IN ($(printf "'%s'," "${CRITICAL_TABLES[@]}" | sed 's/,$//'))
    ORDER BY n_dead_tup DESC;
"

echo ""
echo "========================================================================"
echo "[$(date)] Done"
echo "========================================================================"
