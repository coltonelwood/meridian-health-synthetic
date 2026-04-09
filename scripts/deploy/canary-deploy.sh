#!/usr/bin/env bash
# =============================================================================
# Canary Deployment Script - Meridian Health Technologies
# Author: David Holmes (dholmes@meridianhealth.io)
# Created: 2024-02-15
# Last Modified: 2025-07-11 by ajiang
#
# Deploys a canary version of a service to a subset of pods.
# The canary gets a percentage of traffic routed to it via Istio.
#
# Usage:
#   ./canary-deploy.sh <service-name> <tag> [--env <environment>]
#
# After deploying canary:
#   1. Monitor error rates on Grafana dashboard for 30+ minutes
#   2. If OK, promote: ./canary-deploy.sh <service-name> <tag> --promote
#   3. If bad, abort: ./canary-deploy.sh <service-name> <tag> --abort
#
# NOTE: The canary percentage is hardcoded to 10%. We talked about making it
# configurable but never got around to it. If you need a different percentage,
# edit the CANARY_WEIGHT variable below. (ajiang 2025-07-11)
#
# WARNING: This only works with services that have Istio sidecar injection
# enabled. Currently that's: claims-api, patient-portal, billing-engine,
# scheduling-service. Other services use the simpler blue-green approach.
# =============================================================================

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <service-name> <tag> [--env <environment>] [--promote|--abort]"
    exit 1
fi

SERVICE_NAME="$1"
IMAGE_TAG="$2"
ENVIRONMENT="production"  # canary deploys are production-only really
ACTION="deploy"
shift 2

while [[ $# -gt 0 ]]; do
    case $1 in
        --env)
            ENVIRONMENT="$2"
            shift 2
            ;;
        --promote)
            ACTION="promote"
            shift
            ;;
        --abort)
            ACTION="abort"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Canary traffic percentage - hardcoded for now
# TODO: Make this a CLI argument (dholmes, 2024-02-15)
# Still TODO as of 2025-07-11 lol - ajiang
CANARY_WEIGHT=10
STABLE_WEIGHT=$((100 - CANARY_WEIGHT))

NAMESPACE="meridian-${ENVIRONMENT}"
REGISTRY="ecr.meridianhealth.io"
KUBE_CONTEXT="meridian-${ENVIRONMENT}"
SLACK_WEBHOOK_URL="${SLACK_DEPLOY_WEBHOOK:-}"

kubectl config use-context "${KUBE_CONTEXT}" &>/dev/null || {
    echo "ERROR: Could not switch to context ${KUBE_CONTEXT}"
    exit 1
}

notify() {
    local msg="$1"
    local color="${2:-#439FE0}"
    if [[ -n "$SLACK_WEBHOOK_URL" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-type: application/json' \
            -d "{\"attachments\":[{\"color\":\"${color}\",\"text\":\"[Canary] ${msg}\"}]}" \
            > /dev/null 2>&1 || true
    fi
}

case "$ACTION" in
    deploy)
        echo "========================================================================"
        echo "  CANARY DEPLOY"
        echo "  Service: ${SERVICE_NAME}"
        echo "  Tag: ${IMAGE_TAG}"
        echo "  Traffic: ${CANARY_WEIGHT}% canary / ${STABLE_WEIGHT}% stable"
        echo "  Environment: ${ENVIRONMENT}"
        echo "========================================================================"
        echo ""

        notify "Deploying canary ${SERVICE_NAME}:${IMAGE_TAG} (${CANARY_WEIGHT}% traffic)"

        # Deploy the canary as a separate deployment
        CANARY_DEPLOYMENT="${SERVICE_NAME}-canary"

        # Check if canary already exists
        if kubectl get deployment "${CANARY_DEPLOYMENT}" -n "${NAMESPACE}" &>/dev/null; then
            echo "WARNING: Canary deployment already exists. Updating it."
        fi

        # Create/update canary deployment from existing stable deployment
        kubectl get deployment "${SERVICE_NAME}" -n "${NAMESPACE}" -o json \
            | jq --arg name "${CANARY_DEPLOYMENT}" \
                  --arg image "${REGISTRY}/${SERVICE_NAME}:${IMAGE_TAG}" \
                  --arg version "canary" \
            '
                .metadata.name = $name |
                .metadata.labels.version = $version |
                .spec.replicas = 1 |
                .spec.selector.matchLabels.version = $version |
                .spec.template.metadata.labels.version = $version |
                .spec.template.spec.containers[0].image = $image |
                del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .status)
            ' \
            | kubectl apply -n "${NAMESPACE}" -f -

        echo "Canary deployment created. Waiting for pods..."
        kubectl rollout status deployment/"${CANARY_DEPLOYMENT}" -n "${NAMESPACE}" --timeout=300s

        # Update Istio VirtualService to split traffic
        echo "Configuring traffic split: ${CANARY_WEIGHT}% canary / ${STABLE_WEIGHT}% stable"

        cat <<VSEOF | kubectl apply -n "${NAMESPACE}" -f -
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: ${SERVICE_NAME}
  namespace: ${NAMESPACE}
spec:
  hosts:
    - ${SERVICE_NAME}
  http:
    - route:
        - destination:
            host: ${SERVICE_NAME}
            subset: stable
          weight: ${STABLE_WEIGHT}
        - destination:
            host: ${SERVICE_NAME}
            subset: canary
          weight: ${CANARY_WEIGHT}
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: ${SERVICE_NAME}
  namespace: ${NAMESPACE}
spec:
  host: ${SERVICE_NAME}
  subsets:
    - name: stable
      labels:
        version: stable
    - name: canary
      labels:
        version: canary
VSEOF

        echo ""
        echo "========================================================================"
        echo "  Canary deployed!"
        echo ""
        echo "  Monitor: https://grafana.meridianhealth.io/d/${SERVICE_NAME}-canary"
        echo ""
        echo "  After monitoring for 30+ minutes:"
        echo "    Promote: $0 ${SERVICE_NAME} ${IMAGE_TAG} --promote"
        echo "    Abort:   $0 ${SERVICE_NAME} ${IMAGE_TAG} --abort"
        echo "========================================================================"
        ;;

    promote)
        echo "Promoting canary to stable..."
        notify "Promoting canary ${SERVICE_NAME}:${IMAGE_TAG} to stable" "#36a64f"

        # Update the stable deployment with the canary image
        kubectl set image deployment/"${SERVICE_NAME}" \
            "${SERVICE_NAME}=${REGISTRY}/${SERVICE_NAME}:${IMAGE_TAG}" \
            -n "${NAMESPACE}"

        echo "Waiting for stable rollout..."
        kubectl rollout status deployment/"${SERVICE_NAME}" -n "${NAMESPACE}" --timeout=600s

        # Remove canary deployment
        echo "Removing canary deployment..."
        kubectl delete deployment "${SERVICE_NAME}-canary" -n "${NAMESPACE}" --ignore-not-found

        # Reset traffic to 100% stable
        cat <<VSEOF | kubectl apply -n "${NAMESPACE}" -f -
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: ${SERVICE_NAME}
  namespace: ${NAMESPACE}
spec:
  hosts:
    - ${SERVICE_NAME}
  http:
    - route:
        - destination:
            host: ${SERVICE_NAME}
            subset: stable
          weight: 100
VSEOF

        echo ""
        echo "Canary promoted successfully!"
        notify ":white_check_mark: Canary ${SERVICE_NAME}:${IMAGE_TAG} promoted to stable" "#36a64f"
        ;;

    abort)
        echo "Aborting canary deployment..."
        notify ":octagonal_sign: Aborting canary ${SERVICE_NAME}:${IMAGE_TAG}" "#FF0000"

        # Delete canary deployment
        kubectl delete deployment "${SERVICE_NAME}-canary" -n "${NAMESPACE}" --ignore-not-found

        # Reset traffic to 100% stable
        cat <<VSEOF | kubectl apply -n "${NAMESPACE}" -f -
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: ${SERVICE_NAME}
  namespace: ${NAMESPACE}
spec:
  hosts:
    - ${SERVICE_NAME}
  http:
    - route:
        - destination:
            host: ${SERVICE_NAME}
            subset: stable
          weight: 100
VSEOF

        echo "Canary aborted. All traffic is back on stable."
        notify "Canary aborted. All traffic on stable version." "#FFA500"
        ;;
esac
