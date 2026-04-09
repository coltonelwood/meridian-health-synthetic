# Postmortem: Claims Queue Backup

**Date of Incident:** 2025-01-20
**Duration:** 4 hours 23 minutes
**Severity:** SEV-2
**Author:** Priya Sharma
**Postmortem Date:** 2025-01-23

## Summary

On January 20, 2025, the claims processing queue backed up to over 8,400 messages, causing a 4-hour delay in claim submissions to clearinghouses. The root cause was a database deadlock in the claim status update logic that caused the claims-service consumer to hang. The deadlock was triggered by a combination of the end-of-month batch reprocessing job and normal real-time claim creation.

## Impact

- **4 hours 23 minutes** of delayed claim submissions
- **8,412 claims** queued during the outage
- **0 claims lost** (all were eventually processed)
- **Timely filing risk** for 23 claims that were near their filing deadline
- Billing team unable to view real-time claim status during the outage
- **No patient-facing impact** (claim submission is an internal process)

## Timeline (all times ET)

| Time | Event |
|------|-------|
| Jan 20, 09:00 | End-of-month reprocessing batch job starts (reprocesses ~2,000 denied claims) |
| Jan 20, 09:12 | First deadlock detected in claims database - claims-service consumer hangs |
| Jan 20, 09:15 | RabbitMQ queue begins growing (normal claim creation continues) |
| Jan 20, 09:30 | Datadog alert: "Claims queue depth > 500" - acknowledged by on-call |
| Jan 20, 09:35 | On-call checks claims-service health endpoint - returns healthy (health check doesn't verify consumer) |
| Jan 20, 09:40 | On-call restarts claims-service pods - queue briefly drains then backs up again |
| Jan 20, 09:50 | Deadlock recurs within 3 minutes of restart |
| Jan 20, 10:00 | Priya S. (claims owner) joins investigation |
| Jan 20, 10:15 | Database deadlock identified in `pg_locks` query |
| Jan 20, 10:20 | Batch reprocessing job identified as conflicting with real-time processing |
| Jan 20, 10:30 | Batch job killed manually |
| Jan 20, 10:35 | Claims-service consumer recovers |
| Jan 20, 10:40 | Queue begins draining (~35 claims/minute) |
| Jan 20, 13:23 | Queue fully drained. All 8,412 claims processed. |
| Jan 20, 14:00 | Incident resolved. Post-incident checks confirm all claims submitted to clearinghouse. |

## Root Cause

The deadlock occurred because two processes were updating the same claim records in different orders:

**Process 1 (Real-time claim processing):**
1. Lock claim row (UPDATE status to 'processing')
2. Lock claim_line_items rows (UPDATE amounts)
3. Lock claim row (UPDATE status to 'submitted')

**Process 2 (Batch reprocessing job):**
1. Lock claim_line_items rows (recalculate amounts)
2. Lock claim row (UPDATE status)

When a claim was being processed in real-time AND was also in the batch reprocessing set (a denied claim being resubmitted), the two processes would lock rows in opposite order, causing a classic deadlock cycle.

PostgreSQL detected the deadlock and killed one transaction (the real-time processor), but the claims-service consumer didn't handle the deadlock error correctly. Instead of retrying or NACKing the message, it entered an error state that prevented it from consuming further messages.

```python
# The problematic error handling
try:
    process_claim(claim_data)
except Exception as e:
    logger.error(f"Failed to process claim: {e}")
    # BUG: This acknowledged the message but didn't process it
    # AND left the consumer in a broken state for subsequent messages
    channel.basic_ack(delivery_tag)  # Should have been basic_nack with requeue
```

## Contributing Factors

1. **No deadlock retry logic** - The claims-service didn't handle `psycopg2.errors.DeadlockDetected` specifically
2. **Batch job ran during business hours** - The reprocessing job should run during off-peak hours
3. **Consumer error handling** - ACKing on error meant the failed message was lost from the queue, and the broken consumer state blocked all subsequent processing
4. **Health check gap** - The health endpoint didn't verify the RabbitMQ consumer was actively consuming
5. **No circuit breaker** between the batch job and real-time processing

## Resolution

### Immediate (Jan 20)

1. Killed the batch reprocessing job
2. Restarted claims-service to clear the broken consumer state
3. Queue drained naturally over ~3 hours

### Short-term (Jan 21-24)

1. Fixed consumer error handling to NACK and requeue on deadlock:
   ```python
   except psycopg2.errors.DeadlockDetected:
       logger.warning(f"Deadlock detected for claim {claim_id}, requeueing")
       channel.basic_nack(delivery_tag, requeue=True)
       time.sleep(random.uniform(0.5, 2.0))  # Jitter before retry
   ```

2. Added circuit breaker to prevent batch jobs from running when real-time queue depth > 100

3. Rescheduled batch reprocessing to run at 2:00 AM ET (off-peak)

4. Enhanced health check to verify consumer status:
   ```python
   @app.get("/health")
   async def health():
       return {
           "status": "ok" if consumer.is_consuming else "degraded",
           "consumer_active": consumer.is_consuming,
           "last_message_processed_at": consumer.last_processed_at,
           "queue_depth": await get_queue_depth()
       }
   ```

### Long-term (Feb 2025)

1. Refactored claim status updates to use `SELECT ... FOR UPDATE SKIP LOCKED` to avoid deadlocks:
   ```sql
   UPDATE claims
   SET status = 'processing', updated_at = NOW()
   WHERE claim_id = $1
   AND pg_try_advisory_xact_lock(hashtext($1))
   RETURNING *;
   ```

2. Separated batch reprocessing into its own consumer group with lower priority

3. Added queue depth alerting with escalation:
   - Warning at 200 messages
   - Critical at 1,000 messages
   - Auto-scale consumers at 500 messages

## Lessons Learned

1. **Deadlocks are a code smell.** If two processes can deadlock, the transaction ordering needs to be redesigned, not just retried.
2. **Never ACK a message on error.** Failed messages should be NACKed with requeue (for transient errors) or routed to a dead letter queue (for permanent errors).
3. **Health checks must verify actual functionality**, not just that the process is alive. A consumer that's not consuming is effectively dead.
4. **Batch jobs and real-time processing are a dangerous combination** when they touch the same data. Use locking strategies or scheduling to prevent conflicts.
5. **Circuit breakers between batch and real-time workloads** are essential for protecting real-time SLAs.

## Action Items

| Action | Owner | Status | Due Date |
|--------|-------|--------|----------|
| Fix consumer NACK on deadlock | Priya S. | Done | 2025-01-21 |
| Circuit breaker for batch jobs | Priya S. | Done | 2025-01-24 |
| Move batch to off-peak hours | Priya S. | Done | 2025-01-21 |
| Enhanced health check | Priya S. | Done | 2025-01-22 |
| Refactor to SKIP LOCKED | Priya S. | Done | 2025-02-15 |
| Queue depth auto-scaling | Tom K. | Done | 2025-02-28 |
| Review all consumer error handling | All teams | In Progress | 2025-03-15 |
| Timely filing check for delayed claims | Billing team | Done | 2025-01-21 |
