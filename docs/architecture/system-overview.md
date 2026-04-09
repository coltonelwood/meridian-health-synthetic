# System Architecture Overview

> **Last updated:** 2024-09 (partially outdated - see notes below)
>
> **Owner:** Platform Team

## High-Level Architecture

Meridian Health Technologies runs a microservices architecture on AWS, with services communicating via REST APIs and asynchronous events through RabbitMQ.

```
                                    +-----------------+
                                    |   CloudFront    |
                                    |   (CDN/WAF)     |
                                    +--------+--------+
                                             |
                                    +--------+--------+
                                    |   AWS ALB       |
                                    |   (Load Bal.)   |
                                    +--------+--------+
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
           +--------+--------+    +---------+--------+    +---------+--------+
           |  Patient Portal |    |   Provider App   |    |   Admin Portal   |
           |  (React SPA)    |    |   (React SPA)    |    |   (React SPA)    |
           +-----------------+    +------------------+    +------------------+
                    |                        |                        |
           +--------+--------+    +---------+--------+    +---------+--------+
           |   API Gateway   |    |   API Gateway    |    |   API Gateway    |
           |   (Kong)        |    |   (Kong)         |    |   (Kong)         |
           +--------+--------+    +---------+--------+    +---------+--------+
                    |                        |                        |
  +-----------------+------------------------+------------------------+--+
  |                           Service Mesh (Istio)                       |
  |                                                                      |
  |  +------------+  +------------+  +------------+  +------------+      |
  |  | auth-      |  | patient-   |  | scheduling-|  | billing-   |      |
  |  | service    |  | service    |  | service    |  | service    |      |
  |  +-----+------+  +-----+------+  +-----+------+  +-----+------+     |
  |        |               |               |               |             |
  |  +-----+------+  +-----+------+  +-----+------+  +-----+------+     |
  |  | claims-    |  | documents- |  | notification|  | analytics- |     |
  |  | service    |  | service    |  | -service   |  | service    |      |
  |  +-----+------+  +-----+------+  +-----+------+  +-----+------+     |
  |        |               |               |               |             |
  |  +-----+------+  +-----+------+  +-----+------+                     |
  |  | audit-     |  | fhir-      |  | eligibility|                     |
  |  | service    |  | gateway    |  | -service   |                     |
  |  +------------+  +------------+  +------------+                     |
  |                                                                      |
  +----------------------------------------------------------------------+
                    |                        |
           +--------+--------+    +---------+--------+
           |   RabbitMQ      |    |   Redis          |
           |   (Events)      |    |   (Cache)        |
           +--------+--------+    +------------------+
                    |
  +-----------------+------------------------------------------+
  |                     Data Layer                              |
  |                                                             |
  |  +------------+  +------------+  +------------+             |
  |  | PostgreSQL |  | PostgreSQL |  | MongoDB    |             |
  |  | (Primary)  |  | (Analytics)|  | (Documents)|             |
  |  +------------+  +------------+  +------------+             |
  |                                                             |
  |  +------------+  +------------+                             |
  |  | S3         |  | ElastiCache|                             |
  |  | (Files)    |  | (Sessions) |                             |
  |  +------------+  +------------+                             |
  +-------------------------------------------------------------+
```

> **NOTE:** The diagram above is partially outdated:
> - `notification-service` was renamed to `comms-service` in Q3 2024
> - `ElastiCache (Sessions)` is no longer used for sessions since the JWT migration
> - A new `consent-service` was added in Q1 2025 but is not shown
> - The FHIR gateway is now called `fhir-facade` in the codebase

## Services

| Service | Language | Database | Description |
|---------|----------|----------|-------------|
| auth-service | Node.js | PostgreSQL | JWT-based authentication and authorization |
| patient-service | Node.js | PostgreSQL | Patient demographics, search, merge |
| scheduling-service | Go | PostgreSQL | Appointment scheduling, provider calendars |
| billing-service | Python | PostgreSQL | Claim creation, billing calculations, statements |
| claims-service | Python | PostgreSQL | Claim submission, ERA processing, adjudication |
| documents-service | Node.js | MongoDB + S3 | Document storage and retrieval |
| comms-service | Node.js | PostgreSQL | Email, SMS, push notifications |
| analytics-service | Python | PostgreSQL (analytics) | Reporting, dashboards, data exports |
| audit-service | Go | PostgreSQL | HIPAA audit logging, access tracking |
| fhir-facade | Java | - | FHIR R4 API facade over internal services |
| eligibility-service | Node.js | Redis (cache) | Insurance eligibility verification |

## Key Design Decisions

1. **Database per service** - Each service owns its data. No shared databases (except analytics read replicas).
2. **Event-driven communication** - Services publish events to RabbitMQ for async workflows (claim submission, notifications).
3. **API Gateway** - Kong handles routing, rate limiting, API key management, and request/response transformation.
4. **Service Mesh** - Istio provides mTLS between services, traffic management, and observability.

## Infrastructure

- **Cloud:** AWS (us-east-1 primary, us-west-2 DR)
- **Orchestration:** EKS (Kubernetes)
- **CI/CD:** GitHub Actions -> ECR -> ArgoCD
- **Monitoring:** Datadog (metrics, traces, logs)
- **Alerting:** PagerDuty
- **Secrets:** AWS Secrets Manager
- **DNS:** Route 53

## HIPAA Considerations

- All data at rest encrypted with AES-256 (AWS KMS managed keys)
- All data in transit encrypted with TLS 1.2+
- VPC with private subnets for all services
- WAF rules on CloudFront and ALB
- Audit logging on all PHI access (audit-service)
- 6-year retention policy on audit logs
- BAA in place with AWS and all sub-processors
