#!/usr/bin/env bash
# =============================================================================
# Rollback Script - Meridian Health Technologies
# Author: David Holmes (dholmes@meridianhealth.io)
# Created: 2023-04-10
# Last Modified: 2025-08-29 by dholmes
#
# Rolls back a service to its previous deployment revision.
#
# Usage:
#   ./rollback.sh <service-name> <environment>
#   ./rollback.sh <service-name> <environment> --revision <number>
#
# TODO: We should check the health of the rollback target before considering
# the rollback complete. Right now we just kick off the rollback and hope
# for the best. If the previous version was also broken, we'll just be
# rolling back to another broken state.
# See: https://meridian.atlassian.net/browse/INFRA-3102
# =============================================================================

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <service-name> <environment> [--revision <number>]"
    exit 1
fi

SERVICE_NAME="$1"
ENVIRONMENT="$2"
REVISION=""
shift 2

while [[ $# -gt 0 ]]; do
    case $1 in
        --revision)
            REVISION="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

NAMESPACE="meridian-${ENVIRONMENT}"
KUBE_CONTEXT="meridian-${ENVIRONMENT}"
SLACK_WEBHOOK_URL="${SLACK_DEPLOY_WEBHOOK:-}"

echo "========================================================================"
echo "  ROLLBACK: ${SERVICE_NAME}"
echo "  Environment: ${ENVIRONMENT}"
echo "  Namespace: ${NAMESPACE}"
echo "  Revision: ${REVISION:-previous}"
echo "  Time: $(date)"
echo "========================================================================"

# Safety check for production
if [[ "$ENVIRONMENT" == "production" ]]; then
    echo ""
    echo "  *** PRODUCTION ROLLBACK ***"
    echo ""
    echo "  You are about to rollback ${SERVICE_NAME} in production."
    echo "  Current revision history:"

    kubectl config use-context "${KUBE_CONTEXT}" &>/dev/null

    helm history "${SERVICE_NAME}" -n "${NAMESPACE}" --max 5 2>/dev/null || {
        echo "  Could not fetch history. Is the service deployed?"
        exit 1
    }

    echo ""
    read -r -p "  Continue with rollback? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
        echo "  Aborted."
        exit 0
    fi
fi

# Switch context
kubectl config use-context "${KUBE_CONTEXT}" 2>/dev/null || {
    echo "ERROR: Could not switch to context ${KUBE_CONTEXT}"
    exit 1
}

# Capture current state before rollback (for audit trail)
echo ""
echo "Current deployment state:"
kubectl get deployment "${SERVICE_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='  Image: {.spec.template.spec.containers[0].image}{"\n"}  Replicas: {.spec.replicas}{"\n"}  Ready: {.status.readyReplicas}{"\n"}' \
    2>/dev/null || echo "  (could not fetch current state)"

echo ""
echo "Starting rollback..."

# Perform rollback
HELM_ARGS=(rollback "${SERVICE_NAME}" --namespace "${NAMESPACE}" --wait --timeout 300s)

if [[ -n "$REVISION" ]]; then
    HELM_ARGS+=("${REVISION}")
fi

if helm "${HELM_ARGS[@]}" 2>&1; then
    echo ""
    echo "Rollback command completed."

    # Check pod status
    echo ""
    echo "Pod status after rollback:"
    kubectl get pods -n "${NAMESPACE}" -l "app=${SERVICE_NAME}" -o wide

    # TODO(dholmes): Actually check health endpoints here
    # For now we just look at pod status and call it good
    # This is the INFRA-3102 issue mentioned above

    echo ""
    echo "New deployment state:"
    kubectl get deployment "${SERVICE_NAME}" -n "${NAMESPACE}" \
        -o jsonpath='  Image: {.spec.template.spec.containers[0].image}{"\n"}  Replicas: {.spec.replicas}{"\n"}  Ready: {.status.readyReplicas}{"\n"}' \
        2>/dev/null

    # Notify
    if [[ -n "$SLACK_WEBHOOK_URL" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-type: application/json' \
            -d "{\"attachments\":[{\"color\":\"#FFA500\",\"title\":\"Rollback: ${SERVICE_NAME}\",\"text\":\"Rolled back ${SERVICE_NAME} in ${ENVIRONMENT}${REVISION:+ to revision $REVISION}\",\"footer\":\"$(date)\"}]}" \
            > /dev/null 2>&1 || true
    fi

    echo ""
    echo "========================================================================"
    echo "  Rollback COMPLETE"
    echo "  Verify the service is healthy before closing the incident."
    echo "  Dashboard: https://grafana.meridianhealth.io/d/${SERVICE_NAME}"
    echo "========================================================================"
else
    echo "ERROR: Rollback failed!"

    if [[ -n "$SLACK_WEBHOOK_URL" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-type: application/json' \
            -d "{\"attachments\":[{\"color\":\"#FF0000\",\"title\":\"Rollback FAILED: ${SERVICE_NAME}\",\"text\":\":red_circle: Rollback of ${SERVICE_NAME} in ${ENVIRONMENT} FAILED. Manual intervention required.\",\"footer\":\"$(date)\"}]}" \
            > /dev/null 2>&1 || true
    fi

    echo ""
    echo "Manual steps:"
    echo "  1. Check helm history: helm history ${SERVICE_NAME} -n ${NAMESPACE}"
    echo "  2. Check pod logs: kubectl logs -n ${NAMESPACE} -l app=${SERVICE_NAME} --tail=100"
    echo "  3. Consider manual rollback: kubectl rollout undo deployment/${SERVICE_NAME} -n ${NAMESPACE}"
    exit 1
fi
