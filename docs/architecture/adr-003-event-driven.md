# ADR-003: Adopt Event-Driven Architecture with RabbitMQ

**Date:** 2022-01-10
**Status:** Accepted
**Deciders:** VP Engineering (Janet Liu), Principal Engineer (Derek Simmons), Staff Engineer (Tom Kowalski)

## Context

As we've grown to 8 microservices, we're experiencing increasing issues with synchronous inter-service communication:

1. **Cascading failures** - When the notification service is slow, claim processing backs up because it synchronously calls notifications after each claim.
2. **Tight coupling** - The billing service needs to know about patient-service, claims-service, and notification-service endpoints.
3. **Retry complexity** - Each service implements its own retry logic for downstream calls, inconsistently.
4. **Scaling challenges** - End-of-month batch processing causes thundering herd on downstream services.

### Options Considered

1. **RabbitMQ** - Mature, AMQP-based message broker with flexible routing
2. **Apache Kafka** - Distributed event streaming platform, high throughput
3. **AWS SQS/SNS** - Managed message queue and pub/sub
4. **AWS EventBridge** - Serverless event bus

## Decision

We will adopt **RabbitMQ** (via Amazon MQ) as our event bus for asynchronous inter-service communication.

### Why RabbitMQ over Kafka?

- Our message volumes are moderate (tens of thousands per day, not millions)
- We need flexible routing (topic exchanges, direct exchanges, header-based routing)
- RabbitMQ's message acknowledgment model fits our "at least once" delivery needs
- Simpler operational model for our team size (15 engineers)
- Amazon MQ provides managed RabbitMQ with multi-AZ availability
- We don't need Kafka's event replay/stream processing capabilities (yet)

### Why not SQS/SNS?

- Evaluated but the fan-out pattern with SNS+SQS creates many queues to manage
- No built-in dead letter exchange with flexible retry policies
- Vendor lock-in concerns (we want to keep cloud-portable options)

## Event Architecture

### Patterns

1. **Event Notification** - Services publish events when state changes occur (e.g., `claim.created`, `patient.updated`)
2. **Event-Carried State Transfer** - Events include enough data for consumers to act without calling back to the producer
3. **Dead Letter Exchanges** - Failed messages route to DLX for retry/investigation

### Exchange Topology

```
meridian.events (topic exchange)
  ├── patient.* -> patient-events-queue (patient-service, analytics-service)
  ├── appointment.* -> scheduling-events-queue (scheduling-service, comms-service)
  ├── claim.* -> claims-events-queue (claims-service, billing-service)
  ├── document.* -> document-events-queue (documents-service)
  └── *.* -> audit-events-queue (audit-service - receives ALL events)

meridian.notifications (direct exchange)
  ├── email -> email-queue (comms-service)
  ├── sms -> sms-queue (comms-service)
  └── push -> push-queue (comms-service)

meridian.dlx (fanout exchange)
  └── dead-letter-queue (alerting + manual processing)
```

### Event Schema

All events follow a standard envelope:

```json
{
  "event_id": "uuid",
  "event_type": "claim.created",
  "timestamp": "2022-01-15T10:30:00Z",
  "source": "claims-service",
  "correlation_id": "uuid",
  "data": { ... }
}
```

## Consequences

### Positive

- Services are decoupled - producers don't need to know about consumers
- Automatic retry with exponential backoff via dead letter exchanges
- Better fault isolation - a slow consumer doesn't block the producer
- Natural scaling - add more consumers to process messages faster
- Audit service can observe all events without any service knowing about it

### Negative

- Eventual consistency - downstream services may have stale data briefly
- Message ordering is not guaranteed across queues
- Debugging distributed workflows is harder (need correlation IDs)
- Need to handle idempotency (duplicate message delivery)
- Additional infrastructure to manage and monitor

### Risks

- **Message loss** - Mitigated by publisher confirms and consumer acknowledgments
- **Poison messages** - Mitigated by dead letter exchanges with max retry count
- **Schema evolution** - Events need backward-compatible changes. Mitigated by including schema version in events.

## Notes

**2023-08 Update:** The event-driven approach has worked well. We process ~50,000 events/day. The DLX has caught several bugs before they caused data issues. Main pain point is debugging - invested in Datadog distributed tracing to correlate events across services.

**2024-06 Update:** Evaluating migration to AWS EventBridge for some use cases (particularly notifications) to reduce operational overhead. RabbitMQ will remain for core business events where we need guaranteed delivery and flexible routing.
