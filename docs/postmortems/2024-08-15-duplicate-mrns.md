# Postmortem: Duplicate MRN Generation

**Date of Incident:** 2024-08-15
**Duration:** ~2 hours (detection), 3 days (full remediation)
**Severity:** SEV-2
**Author:** Maria Chen
**Postmortem Date:** 2024-08-19

## Summary

A race condition in the patient-service's MRN generation logic caused 147 patients to be assigned duplicate Medical Record Numbers (MRNs) between August 12-15, 2024. The issue was discovered when a nurse attempted to pull up a patient record and received a different patient's information.

## Impact

- **147 patients** were assigned duplicate MRNs (74 unique MRN collisions)
- **3 patients** had clinical notes filed under the wrong MRN (caught before any clinical action was taken)
- **No patient harm** occurred, but this was classified as a near-miss safety event
- **~8 hours of staff time** to manually verify and correct affected records
- Mandatory reporting to our compliance team as a potential HIPAA concern (patient records were viewable by staff looking up a different patient)

## Timeline (all times ET)

| Time | Event |
|------|-------|
| Aug 12, 09:00 | Deployment of patient-service v2.14.0 with performance optimization to MRN generation |
| Aug 12-14 | Duplicate MRNs being silently created (no unique constraint at DB level) |
| Aug 15, 10:23 | Nurse at Back Bay clinic reports: "I pulled up MHT-104892 and got a different patient" |
| Aug 15, 10:35 | Front desk confirms issue - two patients share MHT-104892 |
| Aug 15, 10:45 | Incident declared (SEV-2) by on-call engineer (Tom K.) |
| Aug 15, 10:50 | Patient-service logs reviewed - no errors found (MRN generation doesn't log conflicts) |
| Aug 15, 11:15 | Database query reveals 147 patients with duplicate MRNs |
| Aug 15, 11:30 | Root cause identified - race condition in MRN generation |
| Aug 15, 11:45 | Hotfix deployed: add `UNIQUE` constraint to `mrn` column and retry logic |
| Aug 15, 12:00 | Unique constraint fails to apply - 74 duplicates block it |
| Aug 15, 12:30 | Manual dedup process started |
| Aug 15, 14:00 | All duplicates resolved - new unique MRNs assigned to affected patients |
| Aug 15, 14:15 | UNIQUE constraint successfully applied |
| Aug 15, 14:30 | Verified no more duplicates. Incident resolved. |
| Aug 16-18 | Clinical records audit for all 147 affected patients |

## Root Cause

The MRN generation used a `SELECT MAX(mrn_sequence) + 1` pattern to generate the next MRN:

```sql
-- The problematic query (simplified)
SELECT MAX(mrn_sequence) FROM patients;
-- Returns 104891
-- Application sets new MRN = MHT-104892
INSERT INTO patients (mrn, mrn_sequence, ...) VALUES ('MHT-104892', 104892, ...);
```

This worked in production for years because:
1. Patient creation volume was low enough that concurrent inserts were rare
2. The old code had an application-level mutex (Node.js cluster lock) that serialized MRN generation

**In v2.14.0**, as part of a performance optimization, the application-level mutex was removed because it was identified as a bottleneck during batch patient imports. The developer (correctly) identified the mutex as a performance issue but didn't realize it was also serving as a concurrency guard for MRN generation.

With the mutex removed, two concurrent patient creation requests could both read `MAX(mrn_sequence) = 104891` and both attempt to insert `104892`.

**The database had no unique constraint on the `mrn` column** - it was missed during the original schema design in 2019.

## Contributing Factors

1. **No unique constraint at DB level** - This should have been there from day one
2. **No integration test for concurrent MRN generation** - Unit tests only tested sequential creation
3. **Code review missed the concurrency implication** - The PR was focused on performance and the MRN generation change was one of many changes
4. **No monitoring for duplicate MRNs** - We had no alert that would catch this

## Resolution

### Immediate

1. Added `UNIQUE` constraint to `patients.mrn` and `patients.mrn_sequence` columns
2. Changed MRN generation to use PostgreSQL `SEQUENCE`:
   ```sql
   CREATE SEQUENCE mrn_sequence START WITH 105000;
   -- New MRN = 'MHT-' || nextval('mrn_sequence')
   ```
3. Wrote and ran a deduplication script that:
   - Identified all duplicate MRNs
   - Assigned new MRNs to the later-created record
   - Updated all references (appointments, claims, documents)
   - Sent notification to affected clinical staff

### Long-term

1. **[DONE]** Added database-level unique constraint on MRN
2. **[DONE]** Migrated to PostgreSQL SEQUENCE for MRN generation
3. **[DONE]** Added integration test for concurrent patient creation (10 concurrent inserts)
4. **[DONE]** Added monitoring: alert if any duplicate MRNs detected (runs hourly)
5. **[IN PROGRESS]** Audit all other "generate next ID" patterns across services for similar issues
6. **[TODO]** Add a pre-commit check that flags removal of synchronization primitives

## Lessons Learned

1. **Database constraints are your safety net.** Application-level uniqueness checks are not sufficient. Always have a DB-level unique constraint for business-critical identifiers.
2. **Removing synchronization primitives is a high-risk change** that should trigger extra scrutiny in code review.
3. **Patient safety implications** of seemingly minor technical decisions. A duplicate MRN could lead to a patient receiving the wrong medication or treatment.
4. **We need better concurrent integration tests** for critical workflows, not just unit tests.

## Action Items

| Action | Owner | Status | Due Date |
|--------|-------|--------|----------|
| Add UNIQUE constraint on MRN | Maria C. | Done | 2024-08-15 |
| Migrate to PG SEQUENCE | Maria C. | Done | 2024-08-16 |
| Concurrent integration tests | Maria C. | Done | 2024-08-23 |
| Hourly duplicate MRN monitor | Tom K. | Done | 2024-08-20 |
| Audit ID generation patterns | Derek S. | In Progress | 2024-09-15 |
| Clinical records audit | Clinical Team | Done | 2024-08-18 |
| HIPAA incident report | David P. | Done | 2024-08-16 |
