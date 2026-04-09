# Technology Stack

> **Last updated:** 2024-08 (some entries may be outdated)
> **Owner:** Platform Team

## Languages & Runtimes

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| Node.js | 20 LTS | auth-service, patient-service, documents-service, comms-service, eligibility-service | Migrating from 18 LTS |
| Python | 3.11 | billing-service, claims-service, analytics-service | Using 3.12 in some newer services |
| Go | 1.21 | scheduling-service, audit-service | Chosen for performance-critical paths |
| Java | 17 (Corretto) | fhir-facade | Spring Boot 3.x; required for HAPI FHIR library |
| TypeScript | 5.3 | All frontend apps, cron jobs | Strict mode enabled globally |

## Frontend

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| React | 18.2 | Patient portal, provider app, admin portal | Planning upgrade to 19 |
| Next.js | 14 | Patient portal (SSR) | App router |
| Vite | 5.x | Provider app, admin portal (SPA) | - |
| TailwindCSS | 3.4 | All frontend apps | Custom design system on top |
| React Query | 5.x | Data fetching/caching | Replaced Redux for server state |
| Zustand | 4.x | Client-side state | Replaced Redux for client state |
| React Hook Form | 7.x | Form handling | With Zod validation |
| ~~Redux~~ | ~~4.x~~ | ~~Was used in legacy portal~~ | ~~Removed in Q2 2024 migration~~ |

## Backend Frameworks

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| Express.js | 4.x | Node.js services | Evaluating Fastify for new services |
| FastAPI | 0.104 | Python services | Async support for claims processing |
| Flask | 2.3 | analytics-service (legacy) | Should migrate to FastAPI |
| Gin | 1.9 | Go services | - |
| Spring Boot | 3.2 | fhir-facade | With HAPI FHIR 7.x |

## Databases

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| PostgreSQL | 15 | Primary data store for most services | RDS Multi-AZ. Upgrading to 16 in Q2 2025 |
| MongoDB | 7.0 | Document storage | Atlas on AWS |
| Redis | 7.x | Caching, rate limiting | ElastiCache. Was also used for sessions (deprecated) |
| ~~MySQL~~ | ~~5.7~~ | ~~Legacy billing tables~~ | ~~Read-only, being phased out~~ |

## Message Queue & Events

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| RabbitMQ | 3.13 | Event bus, async task processing | Amazon MQ. Considering migration to EventBridge |
| ~~Kafka~~ | - | ~~Evaluated but not adopted~~ | ~~See ADR-005 for reasons~~ |

## Infrastructure & DevOps

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| AWS | - | Cloud infrastructure | us-east-1 primary, us-west-2 DR |
| Kubernetes (EKS) | 1.28 | Container orchestration | Managed node groups |
| Docker | 24.x | Containerization | Multi-stage builds |
| Terraform | 1.6 | Infrastructure as code | State in S3 + DynamoDB lock |
| ArgoCD | 2.9 | GitOps continuous deployment | Watches infra/ repo |
| GitHub Actions | - | CI pipeline | Build, test, push to ECR |
| Istio | 1.20 | Service mesh | mTLS, traffic management |
| Kong | 3.5 | API gateway | Declarative config via deck |

## Observability

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| Datadog | - | Metrics, APM, logs | All services instrumented |
| PagerDuty | - | Alerting, on-call management | Integrated with Datadog |
| Sentry | - | Error tracking | Frontend and backend |
| ~~ELK Stack~~ | - | ~~Was used for logs~~ | ~~Migrated to Datadog in 2023~~ |

## Security & Compliance

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| AWS KMS | - | Encryption key management | Customer-managed CMKs |
| AWS WAF | - | Web application firewall | OWASP Top 10 rules + custom |
| AWS Secrets Manager | - | Secret management | Rotated every 90 days |
| ClamAV | - | File virus scanning | For document uploads |
| OWASP ZAP | - | DAST scanning | Weekly scans in staging |
| Snyk | - | Dependency vulnerability scanning | Integrated in CI |
| SonarQube | - | SAST, code quality | Quality gate enforced |

## Testing

| Technology | Version | Usage | Notes |
|-----------|---------|-------|-------|
| Jest | 29.x | Node.js unit/integration tests | ~85% coverage target |
| pytest | 7.x | Python tests | With pytest-asyncio |
| Go testing | - | Go tests | Standard library |
| Playwright | 1.40 | E2E browser tests | Critical path coverage |
| k6 | - | Load testing | Weekly performance runs |
| Pact | 5.x | Contract testing | Consumer-driven contracts |

## Third-Party Integrations

| Service | Purpose | Notes |
|---------|---------|-------|
| Change Healthcare | Clearinghouse (claims submission) | EDI 837/835 |
| Availity | Eligibility verification (270/271) | Real-time and batch |
| Twilio | SMS notifications | HIPAA-compliant plan |
| SendGrid | Email delivery | Dedicated IP, HIPAA BAA |
| Stripe | Patient payments | PCI DSS compliant |
| DocuSign | E-signatures | Consent forms, agreements |
| Zoom | Telehealth video | ~~Was Twilio Video~~ Switched in 2024 |
