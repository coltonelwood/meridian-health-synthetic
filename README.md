<!-- NOTE: This README needs a major update. Last fully reviewed by @david.chen in Q3 2024 -->
<!-- TODO: Remove references to the old Bamboo CI pipeline - we migrated to GitHub Actions in Jan 2024 -->

# Meridian Health Technologies Platform

[![Build Status](https://ci.meridianhealth.io/badges/platform/main.svg)](https://ci.meridianhealth.io/platform)
[![Coverage](https://ci.meridianhealth.io/badges/platform/coverage.svg)](https://ci.meridianhealth.io/platform/coverage)
[![Deploy Status](https://img.shields.io/badge/deploy-staging-green)](https://deploy.meridianhealth.internal/status)
<!-- ^^^ These badges still point to our old Bamboo instance. Someone should update them. -->
<!-- See: https://meridianhealth.atlassian.net/browse/PLAT-2847 -->

> **Meridian Health Technologies** -- Transforming healthcare operations through intelligent automation.
> Founded in 2018, Meridian builds next-generation patient management and claims processing solutions
> trusted by 200+ healthcare organizations across the United States.

## Platform Overview

The Meridian Platform is a monorepo containing all services that power our healthcare SaaS offering:

- **EHR Integration Engine** (`services/ehr-gateway`) -- HL7 FHIR R4 compliant integration layer supporting Epic, Cerner, Allscripts, and Athenahealth. Handles ADT feeds, CCD documents, and real-time clinical data sync.
- **Claims Processing Pipeline** (`services/claims-engine`) -- End-to-end claims lifecycle management. Supports 837/835 EDI transactions, real-time eligibility verification (270/271), and ERA/EOB processing.
- **Patient Scheduling** (`services/scheduling`) -- Multi-provider scheduling with waitlist management, automated reminders, and telehealth integration.
- **Analytics & Reporting** (`services/analytics-api`) -- HIPAA-compliant analytics dashboard with population health metrics, financial reporting, and custom report builder.
- **Document Management** (`services/doc-service`) -- Clinical document storage, OCR processing, and e-signature workflows. Uses MinIO for S3-compatible object storage.
- **Notification Service** (`services/notifications`) -- Multi-channel notifications (SMS, email, push, fax). Integrates with Twilio and SendGrid.
- **Auth & Identity** (`services/auth`) -- OAuth 2.0 / OpenID Connect identity provider with SMART on FHIR support.

<!-- TODO: Add the new referral-service here once it's out of beta (ETA Q1 2025... lol) -->
<!-- The old `services/patient-portal` has been moved to a separate repo: meridian-health/patient-portal-v2 -->

### Architecture

```
                                    +------------------+
                                    |   API Gateway    |
                                    |   (Kong)         |
                                    +--------+---------+
                                             |
                 +---------------------------+---------------------------+
                 |              |             |            |             |
          +------+------+ +----+----+ +------+------+ +---+----+ +-----+------+
          | Auth Service| | EHR GW  | | Claims Eng. | |Schedule| | Analytics  |
          +------+------+ +----+----+ +------+------+ +---+----+ +-----+------+
                 |              |             |            |             |
                 +---------------------------+---------------------------+
                                             |
                                    +--------+---------+
                                    |   PostgreSQL     |
                                    |   (per-service)  |
                                    +--------+---------+
                                             |
                              +--------------+--------------+
                              |              |              |
                        +-----+----+  +------+-----+  +----+-----+
                        |  Redis   |  | RabbitMQ   |  |  MinIO   |
                        | (cache)  |  | (events)   |  | (docs)   |
                        +----------+  +------------+  +----------+
```

<!-- This diagram is outdated - we added Elasticsearch for audit logs in 2023 -->
<!-- Also missing: the ML scoring service and the FHIR bulk export worker -->

## Getting Started

### Prerequisites

- Node.js >= 18.x (we're on 18.19.0 in CI, 20.x should work but hasn't been fully tested)
- Docker & Docker Compose v2+
- PostgreSQL 15 (if running natively)
- Python 3.11+ (for ML services only)

<!-- FIXME: We should mention that you need the VPN running to hit the dev FHIR sandbox -->

### Setup

1. Clone the repo:
   ```bash
   git clone git@github.com:meridian-health/platform.git
   cd platform
   ```

2. Copy environment config:
   ```bash
   cp .env.example .env
   # Ask someone in #platform-eng for the dev API keys
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Start infrastructure:
   ```bash
   docker-compose up -d postgres redis rabbitmq minio elasticsearch
   ```

5. Run database migrations:
   ```bash
   make db-migrate
   ```

6. Seed development data:
   ```bash
   # TODO: This script is broken as of the multi-tenant migration (PLAT-3201)
   # For now, ask @sarah.martinez for a recent staging DB dump
   npm run seed:dev
   ```

7. Start services:
   ```bash
   npm run dev
   ```

<!-- Steps 8-10 used to be here for setting up the old Angular frontend.
     That's been moved to patient-portal-v2 repo. Need to clean this up. -->

### Running Tests

```bash
# Unit tests
npm test

# Integration tests (requires Docker services running)
npm run test:integration

# E2E tests (requires full stack running)
# NOTE: E2E tests are flaky on M1 Macs due to Playwright/Docker networking issues
npm run test:e2e
```

## Project Structure

```
/
+-- services/          # Microservices
|   +-- auth/          # Authentication & authorization
|   +-- claims-engine/ # Claims processing
|   +-- ehr-gateway/   # EHR integration
|   +-- scheduling/    # Patient scheduling
|   +-- analytics-api/ # Analytics & reporting
|   +-- doc-service/   # Document management
|   +-- notifications/ # Notification service
|   +-- billing/       # DEPRECATED - merged into claims-engine Q2 2024
+-- libs/              # Shared libraries
|   +-- common/        # Common utilities
|   +-- db/            # Database helpers & migrations
|   +-- fhir-client/   # FHIR R4 client library
|   +-- hipaa-audit/   # HIPAA audit logging
+-- infra/             # Terraform & K8s configs
+-- scripts/           # Build & deployment scripts
+-- ml/                # ML models (Python)
+-- docs/              # Documentation (mostly outdated)
+-- config/            # Shared configuration
```

## Deployment

We deploy to AWS EKS. See [Deployment Guide](docs/deployment/DEPLOY.md) for details.
<!-- ^^^ That doc hasn't been updated since we moved from ECS to EKS -->

| Environment | URL | Status |
|------------|-----|--------|
| Development | https://dev.meridianhealth.io | Auto-deploy from `develop` |
| Staging | https://staging.meridianhealth.io | Deploy via GitHub Actions |
| Production | https://app.meridianhealth.io | Deploy via release tags |
| Sandbox | https://sandbox.meridianhealth.io | ~~Manual deploy~~ DECOMISSIONED |

## Key Documentation

- [API Documentation](https://api-docs.meridianhealth.io) (auto-generated from OpenAPI specs)
- [FHIR Implementation Guide](docs/fhir/implementation-guide.md)
- [Claims Processing Workflow](docs/claims/workflow.md)
- [HIPAA Compliance Checklist](docs/compliance/hipaa-checklist.md)
- [Incident Response Runbook](docs/runbooks/incident-response.md)
- [Architecture Decision Records](docs/adr/) <!-- only like 3 of the 28 ADRs are in here, rest are in Confluence -->

## Service Ownership

| Service | Team | Slack Channel | On-call |
|---------|------|---------------|---------|
| auth | Platform Core | #team-platform-core | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/auth) |
| claims-engine | Claims | #team-claims | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/claims) |
| ehr-gateway | Integrations | #team-integrations | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/ehr) |
| scheduling | Patient Experience | #team-patient-exp | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/scheduling) |
| analytics-api | Data & ML | #team-data-ml | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/analytics) |
| doc-service | Platform Core | #team-platform-core | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/docs) |
| notifications | Platform Core | #team-platform-core | [PagerDuty](https://meridianhealth.pagerduty.com/schedules/notif) |

## License

Copyright (c) 2018-2026 Meridian Health Technologies, Inc. All rights reserved.
This software is proprietary and confidential. Unauthorized copying or distribution is strictly prohibited.

---

_Last updated: 2024-09-14 by @david.chen -- yeah I know it needs another update_
