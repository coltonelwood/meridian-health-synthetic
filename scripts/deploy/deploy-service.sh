#!/usr/bin/env bash
# =============================================================================
# Service Deployment Script - Meridian Health Technologies
# Author: David Holmes (dholmes@meridianhealth.io)
# Created: 2023-04-10
# Last Modified: 2025-12-01 by rjohnson
#
# Deploys a service to the specified environment via Helm + kubectl.
#
# Usage:
#   ./deploy-service.sh <service-name> <environment> [--tag <image-tag>]
#
# Examples:
#   ./deploy-service.sh claims-api staging
#   ./deploy-service.sh claims-api staging --tag v2.14.3
#   ./deploy-service.sh patient-portal production --tag v3.1.0
#
# Services: claims-api, patient-portal, scheduling-service, billing-engine,
#   eligibility-service, auth-service, notifications-service, fhir-gateway,
#   document-service, analytics-api
#
# NOTE(rjohnson): I added basic rollback logic in Dec 2025 but it doesn't
# handle all failure modes. Specifically, if the new pods come up but
# health checks are failing intermittently, we won't catch it because we
# only check once after the rollout. Should probably add a soak period.
# =============================================================================

set -euo pipefail

# -- Args ---------------------------------------------------------------------

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <service-name> <environment> [--tag <image-tag>]"
    echo ""
    echo "Available services:"
    echo "  claims-api, patient-portal, scheduling-service, billing-engine,"
    echo "  eligibility-service, auth-service, notifications-service,"
    echo "  fhir-gateway, document-service, analytics-api"
    echo ""
    echo "Environments: staging, production"
    exit 1
fi

SERVICE_NAME="$1"
ENVIRONMENT="$2"
IMAGE_TAG=""
shift 2

while [[ $# -gt 0 ]]; do
    case $1 in
        --tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# -- Config -------------------------------------------------------------------

VALID_SERVICES=(
    "claims-api" "patient-portal" "scheduling-service" "billing-engine"
    "eligibility-service" "auth-service" "notifications-service"
    "fhir-gateway" "document-service" "analytics-api"
)

REGISTRY="ecr.meridianhealth.io"
NAMESPACE="meridian-${ENVIRONMENT}"
HELM_CHART_DIR="./infra/helm/charts/${SERVICE_NAME}"
VALUES_FILE="./infra/helm/values/${ENVIRONMENT}/${SERVICE_NAME}.yaml"
DEPLOY_TIMEOUT="600s"  # 10 minutes
SLACK_WEBHOOK_URL="${SLACK_DEPLOY_WEBHOOK:-}"

# -- Validation ---------------------------------------------------------------

# Check service name is valid
VALID=false
for s in "${VALID_SERVICES[@]}"; do
    if [[ "$s" == "$SERVICE_NAME" ]]; then
        VALID=true
        break
    fi
done

if [[ "$VALID" != "true" ]]; then
    echo "ERROR: Unknown service '${SERVICE_NAME}'"
    echo "Valid services: ${VALID_SERVICES[*]}"
    exit 1
fi

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
    echo "ERROR: Environment must be 'staging' or 'production'"
    exit 1
fi

# Determine image tag
if [[ -z "$IMAGE_TAG" ]]; then
    if [[ "$ENVIRONMENT" == "production" ]]; then
        echo "ERROR: --tag is required for production deployments"
        exit 1
    fi
    # For staging, use latest commit SHA
    IMAGE_TAG=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
    echo "No tag specified, using: ${IMAGE_TAG}"
fi

# -- Functions ----------------------------------------------------------------

notify() {
    local message="$1"
    local color="${2:-#36a64f}"
    if [[ -n "$SLACK_WEBHOOK_URL" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-type: application/json' \
            -d "{\"attachments\":[{\"color\":\"${color}\",\"title\":\"Deploy: ${SERVICE_NAME}\",\"text\":\"${message}\",\"footer\":\"${ENVIRONMENT}\"}]}" \
            > /dev/null 2>&1 || true
    fi
}

check_health() {
    local svc="$1"
    local ns="$2"
    local retries=5
    local wait_seconds=10

    for ((i=1; i<=retries; i++)); do
        echo "[$(date)] Health check attempt ${i}/${retries}..."

        # Get pod names for this deployment
        local pods
        pods=$(kubectl get pods -n "$ns" -l "app=${svc}" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)

        if [[ -z "$pods" ]]; then
            echo "  No pods found, waiting..."
            sleep "$wait_seconds"
            continue
        fi

        local all_ready=true
        for pod in $pods; do
            local ready
            ready=$(kubectl get pod "$pod" -n "$ns" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
            if [[ "$ready" != "True" ]]; then
                all_ready=false
                echo "  Pod ${pod} not ready"
            fi
        done

        if [[ "$all_ready" == "true" ]]; then
            echo "  All pods healthy!"
            return 0
        fi

        sleep "$wait_seconds"
    done

    echo "  Health check failed after ${retries} attempts"
    return 1
}

save_deployment_state() {
    # Save current state for potential rollback
    local state_file="/tmp/meridian-deploy-${SERVICE_NAME}-${ENVIRONMENT}.json"

    kubectl get deployment "${SERVICE_NAME}" -n "${NAMESPACE}" -o json > "${state_file}" 2>/dev/null || {
        echo "WARNING: Could not save current deployment state (new deployment?)"
        return 0
    }

    echo "Saved current state to ${state_file}"
}

# -- Main ---------------------------------------------------------------------

echo "========================================================================"
echo "  Deploying: ${SERVICE_NAME}"
echo "  Environment: ${ENVIRONMENT}"
echo "  Image: ${REGISTRY}/${SERVICE_NAME}:${IMAGE_TAG}"
echo "  Namespace: ${NAMESPACE}"
echo "  Time: $(date)"
echo "========================================================================"
echo ""

# Check cluster connectivity
if ! kubectl cluster-info &>/dev/null; then
    echo "ERROR: Cannot connect to Kubernetes cluster"
    echo "Make sure your kubeconfig is set up correctly."
    exit 1
fi

# Switch to correct context
KUBE_CONTEXT="meridian-${ENVIRONMENT}"
echo "Switching to context: ${KUBE_CONTEXT}"
kubectl config use-context "${KUBE_CONTEXT}" 2>/dev/null || {
    echo "ERROR: Could not switch to context ${KUBE_CONTEXT}"
    echo "Available contexts:"
    kubectl config get-contexts -o name
    exit 1
}

# Save current state
echo "Saving current deployment state..."
save_deployment_state

notify "Starting deploy of ${SERVICE_NAME}:${IMAGE_TAG} to ${ENVIRONMENT}" "#439FE0"

# Check if Helm chart exists
if [[ ! -d "$HELM_CHART_DIR" ]]; then
    echo "ERROR: Helm chart not found at ${HELM_CHART_DIR}"
    exit 1
fi

# Check if values file exists
if [[ ! -f "$VALUES_FILE" ]]; then
    echo "WARNING: Values file not found at ${VALUES_FILE}, using defaults"
    VALUES_FILE=""
fi

# Build Helm args
HELM_ARGS=(
    upgrade --install "${SERVICE_NAME}" "${HELM_CHART_DIR}"
    --namespace "${NAMESPACE}"
    --set "image.repository=${REGISTRY}/${SERVICE_NAME}"
    --set "image.tag=${IMAGE_TAG}"
    --set "environment=${ENVIRONMENT}"
    --timeout "${DEPLOY_TIMEOUT}"
    --wait
    --atomic  # auto-rollback on failure
)

if [[ -n "$VALUES_FILE" ]]; then
    HELM_ARGS+=(-f "$VALUES_FILE")
fi

# Production gets extra replicas
if [[ "$ENVIRONMENT" == "production" ]]; then
    HELM_ARGS+=(--set "replicaCount=3")
fi

# Deploy!
echo ""
echo "Running Helm upgrade..."
if helm "${HELM_ARGS[@]}" 2>&1; then
    echo ""
    echo "Helm upgrade succeeded!"
else
    echo ""
    echo "ERROR: Helm upgrade failed!"
    notify ":red_circle: Deploy FAILED for ${SERVICE_NAME}:${IMAGE_TAG} to ${ENVIRONMENT}" "#FF0000"

    # Helm --atomic should have rolled back, but let's verify
    echo "Checking rollback status..."
    # TODO(dholmes): Actually verify the rollback happened. Right now we just trust --atomic
    exit 1
fi

# Post-deploy health check
echo ""
echo "Running post-deploy health check..."
if check_health "${SERVICE_NAME}" "${NAMESPACE}"; then
    echo ""
    echo "========================================================================"
    echo "  Deploy SUCCESSFUL"
    echo "  Service: ${SERVICE_NAME}"
    echo "  Tag: ${IMAGE_TAG}"
    echo "  Environment: ${ENVIRONMENT}"
    echo "========================================================================"
    notify ":white_check_mark: Successfully deployed ${SERVICE_NAME}:${IMAGE_TAG} to ${ENVIRONMENT}" "#36a64f"
else
    echo ""
    echo "WARNING: Deploy completed but health checks are failing!"
    echo "Consider rolling back with: ./scripts/deploy/rollback.sh ${SERVICE_NAME} ${ENVIRONMENT}"

    # TODO(rjohnson): Should we auto-rollback here? Risky because maybe
    # it's just slow to start up. For now, just warn and let the operator decide.
    notify ":warning: Deployed ${SERVICE_NAME}:${IMAGE_TAG} to ${ENVIRONMENT} but health checks failing!" "#FFA500"
    exit 1
fi
