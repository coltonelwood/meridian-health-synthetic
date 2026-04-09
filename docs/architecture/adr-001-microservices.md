# ADR-001: Adopt Microservices Architecture

**Date:** 2019-06-15
**Status:** Accepted
**Deciders:** CTO (Mark Rivera), VP Engineering (Janet Liu), Principal Engineer (Derek Simmons)

## Context

Meridian Health Technologies is building a healthcare SaaS platform that needs to handle patient management, scheduling, billing, claims processing, and document management. The founding engineering team (5 engineers) needs to choose between a monolithic architecture and a microservices architecture.

Our initial prototype was built as a monolith (the legacy patient portal in `archive/legacy-portal`). While it was fast to build, we're seeing challenges as we add more features:

1. The codebase is becoming difficult to navigate
2. A bug in billing code brought down the patient portal
3. We can't scale billing independently during end-of-month batch processing
4. Different teams want to use different languages (Python for billing/analytics, Node.js for real-time features)

## Decision

We will adopt a microservices architecture with the following principles:

1. **Service boundaries aligned to business domains** - Patient, Scheduling, Billing, Claims, Documents
2. **Database per service** - Each service owns its data to enforce loose coupling
3. **API Gateway** for routing and cross-cutting concerns
4. **Event-driven communication** for async workflows
5. **Containerized deployment** on Kubernetes

## Consequences

### Positive

- Services can be developed, deployed, and scaled independently
- Teams can choose the best language/framework for each service
- Fault isolation - a billing service crash won't take down the patient portal
- Easier to onboard new engineers to a focused service

### Negative

- Operational complexity increases significantly
- Need to invest in observability, service mesh, and deployment tooling
- Distributed transactions are harder (eventual consistency)
- Small team (5 engineers) may struggle with the overhead initially
- Network latency between services adds up

### Risks

- **Over-decomposition** - We might create too many services too early. Mitigation: Start with fewer, larger services and split later.
- **Data consistency** - Without distributed transactions, we need to handle eventual consistency. Mitigation: Use the Saga pattern for cross-service workflows.
- **Team size** - 5 engineers managing multiple services is challenging. Mitigation: Invest heavily in automation and keep service count low initially.

## Notes

**2020-03 Update:** The decision has held up well. We started with 4 services (auth, patient, billing, scheduling) and have grown to 8 as the team scaled to 15 engineers.

**2023-06 Update:** Now at 11 services and 28 engineers. The microservices approach has been mostly positive, though we do struggle with distributed tracing and cross-service testing. Invested in Pact contract testing to address this.
