# Data Flow Diagrams

> **Last updated:** 2024-10
> **Owner:** Platform Team

## Claim Processing Flow

This is the primary data flow for processing healthcare claims from creation to payment posting.

```mermaid
sequenceDiagram
    participant PP as Patient Portal
    participant API as API Gateway
    participant BS as Billing Service
    participant CS as Claims Service
    participant RMQ as RabbitMQ
    participant CH as Clearinghouse
    participant NS as Comms Service
    participant AS as Audit Service

    Note over PP,AS: Claim Creation & Submission

    PP->>API: POST /api/encounters/{id}/close
    API->>BS: Create claim from encounter
    BS->>BS: Calculate charges (fee schedule lookup)
    BS->>BS: Apply payer contract rates
    BS->>CS: Submit claim for processing
    CS->>RMQ: Publish: claim.created
    CS->>AS: Log: claim created (PHI access)
    CS->>CS: Validate claim (scrubbing)

    alt Claim passes validation
        CS->>CH: Submit EDI 837 to clearinghouse
        CS->>RMQ: Publish: claim.submitted
        CH-->>CS: Acknowledgement (TA1/999)
    else Claim fails validation
        CS->>RMQ: Publish: claim.validation_failed
        RMQ->>NS: Trigger notification
        NS->>NS: Send alert to billing team
    end

    Note over PP,AS: Claim Adjudication & Payment

    CH-->>CS: ERA/835 Remittance Advice
    CS->>CS: Parse 835, match to claims
    CS->>CS: Post payments & adjustments
    CS->>RMQ: Publish: claim.adjudicated
    CS->>BS: Update patient balance
    BS->>RMQ: Publish: balance.updated

    alt Patient has balance
        RMQ->>NS: Trigger patient notification
        NS->>PP: Send statement notification
    end

    CS->>AS: Log: payment posted (PHI access)
```

## Patient Management Flow

```mermaid
sequenceDiagram
    participant User as Front Desk Staff
    participant PG as Provider App
    participant API as API Gateway
    participant PS as Patient Service
    participant ES as Eligibility Service
    participant SS as Scheduling Service
    participant RMQ as RabbitMQ
    participant AS as Audit Service

    Note over User,AS: New Patient Registration

    User->>PG: Enter patient demographics
    PG->>API: POST /api/patients
    API->>PS: Create patient record
    PS->>PS: Generate MRN
    PS->>PS: Validate demographics
    PS->>PS: Check for duplicates (MPI matching)

    alt Potential duplicate found
        PS-->>PG: Return potential matches
        PG-->>User: Review potential duplicates
        User->>PG: Confirm new patient or select match
    end

    PS->>RMQ: Publish: patient.created
    PS->>AS: Log: patient record created

    Note over User,AS: Insurance Verification

    RMQ->>ES: Consume: patient.created
    ES->>ES: Run real-time eligibility check (270/271)
    ES->>PS: Update insurance verification status
    ES->>RMQ: Publish: eligibility.verified

    alt Coverage lapsed
        RMQ->>PG: Alert front desk
        PG-->>User: Show coverage warning
    end

    Note over User,AS: Appointment Scheduling

    User->>PG: Search available slots
    PG->>API: GET /api/providers/{id}/slots?date=...
    API->>SS: Find available slots
    SS->>SS: Check provider schedule
    SS->>SS: Exclude existing appointments
    SS->>SS: Apply buffer time rules
    SS-->>PG: Return available slots

    User->>PG: Book appointment
    PG->>API: POST /api/appointments
    API->>SS: Create appointment
    SS->>RMQ: Publish: appointment.created
    SS->>AS: Log: appointment created
```

## Document Upload Flow

```mermaid
flowchart TD
    A[User uploads document] --> B{File type check}
    B -->|Allowed type| C[Virus scan - ClamAV]
    B -->|Disallowed type| D[Reject upload]

    C -->|Clean| E[Encrypt with KMS]
    C -->|Infected| F[Quarantine & alert]

    E --> G[Upload to S3 with SSE-KMS]
    G --> H[Create metadata record in MongoDB]
    H --> I[Publish: document.uploaded]

    I --> J[Audit log entry]
    I --> K{Document type?}

    K -->|Insurance card| L[OCR extraction]
    K -->|Referral letter| M[Flag for review]
    K -->|Lab result| N[Link to encounter]
    K -->|Other| O[No additional processing]

    L --> P[Update insurance info if changed]
```

## Nightly Batch Processing

```mermaid
flowchart LR
    subgraph "Nightly Jobs (2 AM ET)"
        A[Claim Status Check] --> B[Update claim statuses]
        C[Eligibility Check] --> D[Flag lapsed coverage]
        E[Statement Generation] --> F[Queue for mailing]
        G[Report Generation] --> H[Email to management]
    end

    subgraph "Data Sources"
        I[Clearinghouses] --> A
        J[Payer APIs] --> C
        K[Billing Database] --> E
        L[Analytics DB] --> G
    end

    subgraph "Outputs"
        B --> M[Notifications]
        D --> N[Patient alerts]
        F --> O[Print vendor API]
        H --> P[Email distribution list]
    end
```

## Event Bus Topology

Key RabbitMQ exchanges and queues:

| Exchange | Type | Routing Key Pattern | Consumers |
|----------|------|-------------------|-----------|
| `meridian.events` | topic | `patient.*` | patient-service, analytics-service, audit-service |
| `meridian.events` | topic | `appointment.*` | scheduling-service, comms-service, audit-service |
| `meridian.events` | topic | `claim.*` | claims-service, billing-service, analytics-service, audit-service |
| `meridian.events` | topic | `document.*` | documents-service, audit-service |
| `meridian.events` | topic | `eligibility.*` | eligibility-service, patient-service |
| `meridian.notifications` | direct | `email` | comms-service |
| `meridian.notifications` | direct | `sms` | comms-service |
| `meridian.notifications` | direct | `push` | comms-service |
| `meridian.dlx` | fanout | - | Dead letter queue consumer (alerting) |

## Data Retention

| Data Type | Hot Storage | Warm Storage | Cold Storage | Total Retention |
|-----------|-------------|--------------|--------------|-----------------|
| Patient records | Indefinite | - | - | Indefinite |
| Claims | 2 years | 5 years | 7 years | 7 years (regulatory) |
| Audit logs | 1 year | 5 years | 6 years | 6 years (HIPAA) |
| Documents | 2 years | 5 years | S3 Glacier | 10 years |
| Analytics | 1 year | - | - | 1 year (aggregated forever) |
| Session data | 30 minutes | - | - | 30 minutes |
