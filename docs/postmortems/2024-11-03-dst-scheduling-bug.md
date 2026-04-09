# Postmortem: DST Scheduling Bug

**Date of Incident:** 2024-11-03 (Daylight Saving Time transition)
**Duration:** 6 hours (impact), 2 days (full fix)
**Severity:** SEV-2
**Author:** Alex Petrov
**Postmortem Date:** 2024-11-07

## Summary

On November 3, 2024, when Daylight Saving Time ended (clocks fell back from EDT to EST), 89 patient appointments were shifted by 1 hour. Patients who had appointments at 10:00 AM were showing as 9:00 AM in the provider app, while the patient portal showed the original 10:00 AM time. This caused confusion, missed appointments, and scheduling conflicts.

## Impact

- **89 appointments** on November 3rd and 4th had incorrect times displayed
- **12 patients** arrived at the wrong time (based on the provider app time)
- **3 patients** were marked as no-shows but had actually arrived at the correct time per their confirmation email
- **2 providers** had double-booked slots due to the time shift
- Multiple angry calls to our support line
- Approximately **$4,200 in lost revenue** from cancelled/rescheduled appointments

## Timeline (all times ET)

| Time | Event |
|------|-------|
| Nov 3, 02:00 | DST ends - clocks fall back from 02:00 EDT to 01:00 EST |
| Nov 3, 07:15 | scheduling-service cron job runs morning sync; timestamps shifted |
| Nov 3, 08:30 | First patient calls: "My appointment confirmation says 10 AM but the online portal now shows 9 AM" |
| Nov 3, 08:45 | Front desk at Roxbury clinic reports appointment time mismatches |
| Nov 3, 09:00 | On-call engineer (Alex P.) paged |
| Nov 3, 09:15 | Confirmed appointments created before DST are displaying incorrectly |
| Nov 3, 09:30 | Root cause identified - timestamps stored as local time without timezone |
| Nov 3, 09:45 | Manual workaround: front desk staff instructed to use patient confirmation emails as source of truth |
| Nov 3, 10:30 | Hotfix: appointment display code adjusted to account for DST offset |
| Nov 3, 12:00 | All affected appointments manually reviewed and corrected |
| Nov 4, 09:00 | Permanent fix development begins |
| Nov 5, 14:00 | Migration script to convert all timestamps to UTC deployed to staging |
| Nov 6, 02:00 | Migration deployed to production (during maintenance window) |
| Nov 6, 06:00 | Verified all appointments display correctly |

## Root Cause

The scheduling-service stored appointment times as **local timestamps without timezone information** (`TIMESTAMP WITHOUT TIME ZONE` in PostgreSQL). The application assumed `America/New_York` but this assumption was implicit, not stored with the data.

```sql
-- How appointments were stored (WRONG)
CREATE TABLE appointments (
    start_time TIMESTAMP WITHOUT TIME ZONE,  -- e.g., '2024-11-04 10:00:00'
    end_time   TIMESTAMP WITHOUT TIME ZONE
);
```

When the scheduling-service's daily sync job ran after the DST transition, it compared timestamps in the new EST offset against the database values that were stored in the old EDT offset. The comparison logic used JavaScript `Date` objects, which automatically adjust for the system's current timezone:

```javascript
// The problematic code
const appointmentTime = new Date(row.start_time); // Interpreted as EST (current TZ)
// But the value '2024-11-04 10:00:00' was originally stored as EDT
// Result: time displayed 1 hour early
```

The patient portal's appointment confirmation emails were sent at the time of booking with the correct time hardcoded in the email body, so they still showed the correct time - creating the mismatch.

## Contributing Factors

1. **Timestamps stored without timezone** - A classic mistake. The scheduling-service was one of the first services built (2019) and this pattern was set early.
2. **No timezone-aware testing** - Our test suite didn't include DST transition scenarios.
3. **Inconsistent timezone handling** - The patient portal used `moment-timezone` to display times, while the provider app used browser's native `Date` object. They handled the ambiguous timestamps differently.
4. **The sync job** - The hourly provider schedule sync unnecessarily re-interpreted stored timestamps, amplifying the issue.

## Resolution

### Immediate (Nov 3)

- Front desk staff used confirmation emails as source of truth
- Manually corrected all 89 affected appointments
- Contacted all patients with November 4 appointments to confirm times

### Permanent (Nov 5-6)

1. Migrated all timestamp columns to `TIMESTAMP WITH TIME ZONE`:
   ```sql
   ALTER TABLE appointments
     ALTER COLUMN start_time TYPE TIMESTAMP WITH TIME ZONE
       USING start_time AT TIME ZONE 'America/New_York',
     ALTER COLUMN end_time TYPE TIMESTAMP WITH TIME ZONE
       USING end_time AT TIME ZONE 'America/New_York';
   ```

2. Updated the scheduling-service to:
   - Store all times in UTC internally
   - Accept timezone in API requests (defaults to `America/New_York`)
   - Return times with timezone offset in API responses
   - Store the IANA timezone identifier (`America/New_York`) alongside each appointment

3. Updated all frontend apps to use `date-fns-tz` for consistent timezone-aware display

4. Added DST transition test cases to the scheduling-service integration tests

## Lessons Learned

1. **Always use `TIMESTAMP WITH TIME ZONE` in PostgreSQL.** There is almost never a good reason to use `TIMESTAMP WITHOUT TIME ZONE`. The PostgreSQL docs even recommend this.
2. **Store times in UTC, display in local time.** This is a well-known best practice that we simply didn't follow from the beginning.
3. **Test across DST boundaries.** Our test suite now includes appointments scheduled before DST transitions that are displayed after.
4. **Timezone handling is a system-wide concern.** All services and frontends need to agree on how times are stored and displayed.

## Action Items

| Action | Owner | Status | Due Date |
|--------|-------|--------|----------|
| Migrate to TIMESTAMPTZ | Alex P. | Done | 2024-11-06 |
| Store timezone with appointments | Alex P. | Done | 2024-11-06 |
| DST integration tests | Alex P. | Done | 2024-11-15 |
| Audit all services for timezone handling | Tom K. | Done | 2024-12-01 |
| Standardize on date-fns-tz across frontends | Frontend team | Done | 2024-12-15 |
| Patient apology communications | Ops team | Done | 2024-11-04 |
| Reschedule no-show patients (waive fee) | Front desk | Done | 2024-11-04 |
