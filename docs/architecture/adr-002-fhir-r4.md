# ADR-002: Adopt FHIR R4 for Interoperability

**Date:** 2021-03-20
**Status:** Accepted
**Deciders:** CTO (Mark Rivera), Chief Medical Informatics Officer (Dr. Rachel Nguyen), Principal Engineer (Derek Simmons)

## Context

The 21st Century Cures Act (effective April 2021) requires healthcare organizations to provide patients access to their health information via standardized APIs. CMS and ONC have mandated the use of FHIR (Fast Healthcare Interoperability Resources) R4 as the standard.

We need to:
1. Expose patient data through FHIR-compliant APIs for patient access
2. Support Bulk FHIR for payer-to-payer data exchange
3. Enable interoperability with EHR systems and health information exchanges (HIEs)
4. Comply with the ONC Cures Act Final Rule information blocking provisions

### Options Considered

1. **Build FHIR APIs from scratch** - Map our internal data models to FHIR resources manually
2. **Use HAPI FHIR (Java)** - Mature open-source FHIR server with built-in validation
3. **Use a commercial FHIR platform** (Smile CDR, Google Healthcare API) - Hosted FHIR server
4. **FHIR Facade pattern** - Thin FHIR API layer that translates to/from our existing services

## Decision

We will implement a **FHIR Facade** (Option 4) using the **HAPI FHIR library** (from Option 2) in a dedicated `fhir-facade` service.

The facade will:
- Expose FHIR R4 REST APIs for required resources (Patient, Condition, Observation, MedicationRequest, etc.)
- Translate between FHIR resources and our internal data models
- Handle FHIR-specific concerns (search parameters, _include, paging, SMART on FHIR auth)
- Support Bulk FHIR ($export) for large data sets

We will NOT:
- Replace our internal data models with FHIR (our models are optimized for our workflows)
- Store data in FHIR format internally (performance and query flexibility concerns)
- Use a hosted FHIR server (cost and vendor lock-in concerns)

## Consequences

### Positive

- Compliance with 21st Century Cures Act and ONC regulations
- Interoperability with EHR systems, HIEs, and third-party apps
- HAPI FHIR provides validation, serialization, and conformance checking out of the box
- Facade pattern means our internal services don't need to change
- US Core profiles provide clear implementation guidance

### Negative

- Java service in a primarily Node.js/Python/Go stack (team skill gap)
- FHIR data model is complex - mapping to our models requires significant effort
- HAPI FHIR has a steep learning curve
- Performance overhead of translation layer
- Must keep facade in sync as internal services evolve

### Risks

- **FHIR spec complexity** - The FHIR specification is enormous. Mitigation: Focus only on US Core required resources initially.
- **Mapping accuracy** - Translating between data models can lose information. Mitigation: Extensive integration tests with Touchstone and Inferno test suites.
- **Performance** - Bulk FHIR exports could strain our services. Mitigation: Use background jobs for bulk operations, rate limiting.

## Implementation Notes

Required FHIR R4 Resources (US Core):
- Patient
- Condition
- Observation (vitals, labs)
- MedicationRequest
- AllergyIntolerance
- Procedure
- DiagnosticReport
- DocumentReference
- Encounter
- Immunization
- CarePlan
- CareTeam
- Goal

SMART on FHIR authorization scopes will be handled by the auth-service with OAuth 2.0 + OpenID Connect.

## References

- [HL7 FHIR R4](https://hl7.org/fhir/R4/)
- [US Core Implementation Guide](https://www.hl7.org/fhir/us/core/)
- [ONC Cures Act Final Rule](https://www.healthit.gov/curesrule/)
- [HAPI FHIR](https://hapifhir.io/)
