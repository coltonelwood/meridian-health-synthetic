#!/usr/bin/env bash
# =============================================================================
# Blue-Green Deployment Swap - Meridian Health Technologies
# Author: David Holmes (dholmes@meridianhealth.io)
# Created: 2024-05-20
# Last Modified: 2025-03-14 by dholmes
#
# This is our blue-green swap script. It's... mostly working.
#
# Currently we only use this for the billing-engine because:
# 1. The billing-engine has long-running background jobs that don't play
#    well with rolling deploys (claims processing batches can take 20min)
# 2. We need instant rollback capability for billing (regulatory reasons)
# 3. Canary doesn't make sense for billing because it's not user-facing traffic
#
# How it works:
# - We maintain two deployments: billing-engine-blue and billing-engine-green
# - The Service points to whichever one is "live" via a color label
# - To deploy, we update the idle deployment, verify it, then swap the Service
# - To rollback, we just swap back (takes ~2 seconds)
#
# NOTE(dholmes 2025-03-14): We tried to generalize this for other services
# but it doubles the resource cost (need 2x pods at all times) so we only
# use it for billing. If you're thinking of using this for another service,
# talk to the infra team first about resource planning.
#
# KNOWN ISSUES:
# - If both blue and green are down, the script doesn't handle it gracefully
# - The drain step doesn't actually wait for in-flight requests to complete,
#   it just sleeps for 30 seconds and hopes for the best
# - We should check the batch job queue is empty before swapping but we don't
# =============================================================================

set -euo pipefail

SERVICE_NAME="${1:-billing-engine}"
IMAGE_TAG="${2:-}"
ENVIRONMENT="${3:-production}"
ACTION="${4:-swap}"  # swap, status, or drain

NAMESPACE="meridian-${ENVIRONMENT}"
REGISTRY="ecr.meridianhealth.io"
KUBE_CONTEXT="meridian-${ENVIRONMENT}"

if [[ -z "$IMAGE_TAG" && "$ACTION" == "swap" ]]; then
    echo "Usage: $0 [service-name] <image-tag> [environment] [action]"
    echo ""
    echo "  service-name: billing-engine (default, and honestly the only one that uses this)"
    echo "  image-tag:    Docker image tag to deploy"
    echo "  environment:  production (default) or staging"
    echo "  action:       swap (default), status, or drain"
    echo ""
    echo "Examples:"
    echo "  $0 billing-engine v2.8.1"
    echo "  $0 billing-engine v2.8.1 production swap"
    echo "  $0 billing-engine '' production status"
    exit 1
fi

kubectl config use-context "${KUBE_CONTEXT}" &>/dev/null || {
    echo "ERROR: Could not switch context"
    exit 1
}

# -- Determine current live color ---------------------------------------------

get_live_color() {
    kubectl get service "${SERVICE_NAME}" -n "${NAMESPACE}" \
        -o jsonpath='{.spec.selector.color}' 2>/dev/null || echo "unknown"
}

get_idle_color() {
    local live
    live=$(get_live_color)
    if [[ "$live" == "blue" ]]; then
        echo "green"
    elif [[ "$live" == "green" ]]; then
        echo "blue"
    else
        # Default: assume blue is live, deploy to green
        echo "green"
    fi
}

# -- Actions ------------------------------------------------------------------

case "$ACTION" in
    status)
        echo "=== Blue-Green Status: ${SERVICE_NAME} ==="
        echo ""

        LIVE_COLOR=$(get_live_color)
        echo "Live color: ${LIVE_COLOR}"
        echo ""

        for color in blue green; do
            local_deployment="${SERVICE_NAME}-${color}"
            echo "--- ${color} (${local_deployment}) ---"

            if kubectl get deployment "${local_deployment}" -n "${NAMESPACE}" &>/dev/null; then
                IMAGE=$(kubectl get deployment "${local_deployment}" -n "${NAMESPACE}" \
                    -o jsonpath='{.spec.template.spec.containers[0].image}')
                REPLICAS=$(kubectl get deployment "${local_deployment}" -n "${NAMESPACE}" \
                    -o jsonpath='{.status.readyReplicas}')
                echo "  Image: ${IMAGE}"
                echo "  Ready replicas: ${REPLICAS:-0}"
                echo "  Status: $([ "$color" == "$LIVE_COLOR" ] && echo "LIVE" || echo "IDLE")"
            else
                echo "  Not deployed"
            fi
            echo ""
        done
        ;;

    drain)
        echo "Draining idle deployment..."
        IDLE_COLOR=$(get_idle_color)
        IDLE_DEPLOYMENT="${SERVICE_NAME}-${IDLE_COLOR}"

        echo "Scaling down ${IDLE_DEPLOYMENT}..."
        kubectl scale deployment "${IDLE_DEPLOYMENT}" -n "${NAMESPACE}" --replicas=0
        echo "Done. Idle deployment drained."
        ;;

    swap)
        LIVE_COLOR=$(get_live_color)
        IDLE_COLOR=$(get_idle_color)
        IDLE_DEPLOYMENT="${SERVICE_NAME}-${IDLE_COLOR}"

        echo "========================================================================"
        echo "  BLUE-GREEN SWAP: ${SERVICE_NAME}"
        echo "  Current live: ${LIVE_COLOR}"
        echo "  Deploying to: ${IDLE_COLOR}"
        echo "  Image: ${REGISTRY}/${SERVICE_NAME}:${IMAGE_TAG}"
        echo "  Environment: ${ENVIRONMENT}"
        echo "========================================================================"
        echo ""

        # Step 1: Update idle deployment with new image
        echo "[1/5] Updating ${IDLE_DEPLOYMENT} with new image..."
        kubectl set image deployment/"${IDLE_DEPLOYMENT}" \
            "${SERVICE_NAME}=${REGISTRY}/${SERVICE_NAME}:${IMAGE_TAG}" \
            -n "${NAMESPACE}"

        # Scale up idle if it was scaled down
        echo "[2/5] Ensuring ${IDLE_DEPLOYMENT} has correct replica count..."
        LIVE_REPLICAS=$(kubectl get deployment "${SERVICE_NAME}-${LIVE_COLOR}" -n "${NAMESPACE}" \
            -o jsonpath='{.spec.replicas}')
        kubectl scale deployment "${IDLE_DEPLOYMENT}" -n "${NAMESPACE}" \
            --replicas="${LIVE_REPLICAS}"

        echo "Waiting for rollout..."
        kubectl rollout status deployment/"${IDLE_DEPLOYMENT}" -n "${NAMESPACE}" --timeout=600s

        # Step 2: Verify idle is healthy
        echo "[3/5] Verifying ${IDLE_COLOR} pods are healthy..."
        sleep 15  # give it a moment to stabilize

        READY=$(kubectl get deployment "${IDLE_DEPLOYMENT}" -n "${NAMESPACE}" \
            -o jsonpath='{.status.readyReplicas}')
        DESIRED=$(kubectl get deployment "${IDLE_DEPLOYMENT}" -n "${NAMESPACE}" \
            -o jsonpath='{.spec.replicas}')

        if [[ "${READY:-0}" != "${DESIRED}" ]]; then
            echo "ERROR: ${IDLE_COLOR} pods not ready (${READY:-0}/${DESIRED})"
            echo "Aborting swap."
            exit 1
        fi

        echo "  ${READY}/${DESIRED} pods ready."

        # Step 3: Swap the service selector
        echo "[4/5] Swapping service selector to ${IDLE_COLOR}..."

        # This is the actual swap - just changing the service selector
        kubectl patch service "${SERVICE_NAME}" -n "${NAMESPACE}" \
            -p "{\"spec\":{\"selector\":{\"color\":\"${IDLE_COLOR}\"}}}"

        echo "  Service now pointing to ${IDLE_COLOR}!"

        # Step 4: Wait for in-flight requests to drain from old pods
        echo "[5/5] Draining old ${LIVE_COLOR} pods..."
        # TODO(dholmes): This should actually check the connection count
        # on the old pods rather than blindly sleeping. But sleep works
        # "well enough" for billing-engine since it doesn't get that many
        # concurrent requests.
        echo "  Waiting 30 seconds for in-flight requests..."
        sleep 30

        # Don't scale down the old deployment - keep it warm for instant rollback
        echo "  Old ${LIVE_COLOR} deployment kept running for rollback."

        echo ""
        echo "========================================================================"
        echo "  SWAP COMPLETE"
        echo "  ${IDLE_COLOR} is now LIVE with ${IMAGE_TAG}"
        echo "  ${LIVE_COLOR} is IDLE (ready for instant rollback)"
        echo ""
        echo "  To rollback: kubectl patch service ${SERVICE_NAME} -n ${NAMESPACE} \\"
        echo "    -p '{\"spec\":{\"selector\":{\"color\":\"${LIVE_COLOR}\"}}}'"
        echo ""
        echo "  Monitor: https://grafana.meridianhealth.io/d/billing-engine"
        echo "========================================================================"
        ;;

    *)
        echo "Unknown action: ${ACTION}"
        echo "Valid actions: swap, status, drain"
        exit 1
        ;;
esac
