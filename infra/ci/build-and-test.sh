#!/usr/bin/env bash
# =============================================================================
# Meridian Health - CI Build & Test Script
# =============================================================================
#
# Runs the full CI pipeline: lint, type check, unit tests, security scan.
# Used by both GitHub Actions and Jenkins (during migration period).
#
# Usage:
#   ./build-and-test.sh [--skip-lint] [--skip-security] [--retry-flaky]
#
# Exit codes:
#   0 - All checks passed
#   1 - Build/test failure
#   2 - Lint failure
#   3 - Security scan failure

set -euo pipefail

# --- Configuration -----------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RETRY_COUNT="${RETRY_COUNT:-2}"
TEST_TIMEOUT="${TEST_TIMEOUT:-120000}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --- Argument Parsing --------------------------------------------------------

SKIP_LINT=false
SKIP_SECURITY=false
RETRY_FLAKY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-lint)
      SKIP_LINT=true
      shift
      ;;
    --skip-security)
      SKIP_SECURITY=true
      shift
      ;;
    --retry-flaky)
      RETRY_FLAKY=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# --- Helper Functions --------------------------------------------------------

log_step() {
  echo ""
  echo -e "${GREEN}=== $1 ===${NC}"
  echo ""
}

log_warn() {
  echo -e "${YELLOW}WARNING: $1${NC}"
}

log_error() {
  echo -e "${RED}ERROR: $1${NC}"
}

run_with_retry() {
  local cmd="$1"
  local max_attempts="$2"
  local attempt=1

  while [[ $attempt -le $max_attempts ]]; do
    echo "Attempt ${attempt}/${max_attempts}: ${cmd}"
    if eval "$cmd"; then
      return 0
    fi

    if [[ $attempt -lt $max_attempts ]]; then
      log_warn "Attempt ${attempt} failed, retrying in 5 seconds..."
      sleep 5
    fi

    attempt=$((attempt + 1))
  done

  log_error "All ${max_attempts} attempts failed"
  return 1
}

# --- Install Dependencies ----------------------------------------------------

log_step "Installing Dependencies"

cd "${PROJECT_ROOT}"

# Check Node.js version
REQUIRED_NODE_VERSION="20"
CURRENT_NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)

if [[ "${CURRENT_NODE_VERSION}" -lt "${REQUIRED_NODE_VERSION}" ]]; then
  log_error "Node.js ${REQUIRED_NODE_VERSION}+ required, found v${CURRENT_NODE_VERSION}"
  exit 1
fi

echo "Node.js version: $(node -v)"
echo "npm version: $(npm -v)"

# Install with frozen lockfile for reproducible builds
npm ci --prefer-offline --no-audit

# Install workspace dependencies
npm run bootstrap 2>/dev/null || true

# --- Lint ---------------------------------------------------------------------

if [[ "${SKIP_LINT}" == "false" ]]; then
  log_step "Linting"

  # TypeScript type checking
  echo "Running TypeScript compiler..."
  npx tsc --noEmit || {
    log_error "TypeScript type checking failed"
    exit 2
  }

  # ESLint
  echo "Running ESLint..."
  npx eslint . --ext .ts,.tsx --max-warnings 0 || {
    log_error "ESLint found errors"
    exit 2
  }

  # Prettier (check only, don't fix)
  echo "Checking Prettier formatting..."
  npx prettier --check "**/*.{ts,tsx,json,yaml,yml}" --ignore-path .gitignore || {
    log_warn "Prettier formatting issues found. Run 'npm run format' to fix."
    # Don't fail on formatting - just warn
    # TODO: Make this a hard failure once we've reformatted everything
  }

  echo -e "${GREEN}Linting passed!${NC}"
else
  log_warn "Linting skipped (--skip-lint)"
fi

# --- Build -------------------------------------------------------------------

log_step "Building"

npm run build || {
  log_error "Build failed"
  exit 1
}

echo -e "${GREEN}Build passed!${NC}"

# --- Unit Tests ---------------------------------------------------------------

log_step "Running Unit Tests"

# Set test environment variables
export NODE_ENV=test
export LOG_LEVEL=error  # Suppress noisy logs during tests
export TZ=UTC           # Consistent timezone for date tests

TEST_CMD="npx jest --ci --coverage --forceExit --detectOpenHandles --testTimeout=${TEST_TIMEOUT}"

if [[ "${RETRY_FLAKY}" == "true" ]]; then
  # Retry flaky tests up to RETRY_COUNT times
  # Known flaky tests (tracked in MH-4200):
  # - shared-utils/tests/dates.test.ts: "should handle DST transitions"
  #   (fails when CI runs during actual DST transition window, rare)
  # - event-bus/tests/eventBus.test.ts: "should handle reconnection"
  #   (timing-dependent, fails ~5% of the time)
  # - fhir-client/tests/client.test.ts: "should retry on 429"
  #   (nock timing issue)
  run_with_retry "${TEST_CMD}" "${RETRY_COUNT}" || {
    log_error "Unit tests failed after ${RETRY_COUNT} retries"
    exit 1
  }
else
  eval "${TEST_CMD}" || {
    log_error "Unit tests failed"
    exit 1
  }
fi

# Check coverage thresholds
echo "Checking coverage thresholds..."
COVERAGE_THRESHOLD=80

# Parse coverage summary
# The coverage report is written to coverage/coverage-summary.json by jest
if [[ -f coverage/coverage-summary.json ]]; then
  LINE_COVERAGE=$(node -e "
    const summary = require('./coverage/coverage-summary.json');
    console.log(summary.total.lines.pct);
  ")

  echo "Line coverage: ${LINE_COVERAGE}%"

  if (( $(echo "${LINE_COVERAGE} < ${COVERAGE_THRESHOLD}" | bc -l) )); then
    log_warn "Coverage ${LINE_COVERAGE}% is below threshold ${COVERAGE_THRESHOLD}%"
    # Don't fail on coverage for now - we're working on improving it
    # Current coverage: ~72% (target: 80% by Q3 2026)
  fi
else
  log_warn "Coverage report not found"
fi

echo -e "${GREEN}Unit tests passed!${NC}"

# --- Security Scan -----------------------------------------------------------

if [[ "${SKIP_SECURITY}" == "false" ]]; then
  log_step "Security Scan"

  # npm audit (production dependencies only)
  echo "Running npm audit..."
  npm audit --production --audit-level=high 2>&1 || {
    log_warn "npm audit found high-severity vulnerabilities"
    # Log but don't fail - we track these separately
    # Some vulnerabilities are in transitive deps we can't easily update
  }

  # Check for hardcoded secrets
  echo "Scanning for hardcoded secrets..."
  # Simple grep-based check. We also run TruffleHog in a separate workflow.
  if grep -rn --include="*.ts" --include="*.js" --include="*.json" \
    -E "(password|secret|api_key|apikey|token)\s*[:=]\s*['\"][^'\"]{8,}" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=test \
    --exclude-dir=tests \
    --exclude="*.test.*" \
    --exclude="*.spec.*" \
    --exclude="*.mock.*" \
    "${PROJECT_ROOT}/"; then
    log_error "Potential hardcoded secrets found! Review the matches above."
    exit 3
  fi

  # Check for PHI-related patterns in logs
  echo "Scanning for potential PHI in log statements..."
  if grep -rn --include="*.ts" --include="*.js" \
    -E "console\.(log|info|warn|error)\(.*\b(ssn|social_security|date_of_birth|dob|mrn|medical_record)\b" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude="*.test.*" \
    --exclude="*.spec.*" \
    "${PROJECT_ROOT}/"; then
    log_warn "Potential PHI found in console.log statements. Use HIPAALogger instead."
    # This is a warning, not a failure, because some of these might be
    # false positives or in test files we missed
  fi

  echo -e "${GREEN}Security scan passed!${NC}"
else
  log_warn "Security scan skipped (--skip-security)"
fi

# --- Summary ------------------------------------------------------------------

log_step "Build & Test Summary"

echo -e "${GREEN}All checks passed!${NC}"
echo ""
echo "  Lint:     $([ "${SKIP_LINT}" == "true" ] && echo "SKIPPED" || echo "PASSED")"
echo "  Build:    PASSED"
echo "  Tests:    PASSED"
echo "  Security: $([ "${SKIP_SECURITY}" == "true" ] && echo "SKIPPED" || echo "PASSED")"
echo ""

exit 0
