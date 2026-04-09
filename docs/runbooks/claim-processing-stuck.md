# Runbook: Claims Stuck in Processing

> **Last updated:** 2025-02
> **Owner:** Revenue Cycle Team / Claims Service
> **Alert:** `claims_processing_backlog_high` (PagerDuty)

## Symptoms

- PagerDuty alert: "Claims processing backlog exceeds threshold"
- Datadog dashboard shows claims in `processing` status for > 30 minutes
- Clearinghouse submission queue growing
- Provider app shows "Claim Submission Pending" for recent encounters

## Common Causes

### 1. Clearinghouse API Timeout (Most Common)

**Check:**
```bash
# Look for timeout errors in claims-service logs
kubectl logs -n production deployment/claims-service --tail=200 | grep -i "timeout\|ETIMEDOUT\|clearinghouse"

# Check circuit breaker status
curl -s http://claims-service.production.svc:8080/health/dependencies | jq '.clearinghouse'
```

**Fix:**
- If clearinghouse is down, check their status page: https://status.changehealthcare.com
- The circuit breaker should trip automatically after 5 consecutive failures
- Claims will queue in RabbitMQ and retry when the circuit breaker resets
- If the outage is extended (>1 hour), notify the billing team in `#billing-ops`

### 2. RabbitMQ Queue Backup

**Check:**
```bash
# Check queue depth
curl -s -u $RABBITMQ_USER:$RABBITMQ_PASS \
  "https://rabbitmq.internal.meridianhealth.io/api/queues/%2F/claims-processing" | \
  jq '{messages: .messages, consumers: .consumers, message_stats: .message_stats}'
```

**Fix:**
- If consumers = 0, the claims-service consumer may have crashed:
  ```bash
  kubectl rollout restart deployment/claims-service -n production
  ```
- If messages are growing but consumers are active, check for poison messages:
  ```bash
  # Check dead letter queue
  curl -s -u $RABBITMQ_USER:$RABBITMQ_PASS \
    "https://rabbitmq.internal.meridianhealth.io/api/queues/%2F/claims-processing-dlq" | \
    jq '.messages'
  ```

### 3. Database Deadlock

**Check:**
```sql
-- Check for active locks
SELECT blocked_locks.pid AS blocked_pid,
       blocked_activity.usename AS blocked_user,
       blocking_locks.pid AS blocking_pid,
       blocking_activity.usename AS blocking_user,
       blocked_activity.query AS blocked_statement,
       blocking_activity.query AS blocking_statement
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**Fix:**
- Identify and terminate the blocking query:
  ```sql
  SELECT pg_terminate_backend(<blocking_pid>);
  ```
- If deadlocks are recurring, this may indicate a code issue. Check recent deployments.
- See postmortem `2025-01-20-claims-queue-backup.md` for a previous occurrence.

### 4. Validation Failures (Scrubber Rejections)

**Check:**
```bash
# Check for high validation failure rate
kubectl logs -n production deployment/claims-service --tail=500 | \
  grep "validation_failed" | tail -20
```

**Common validation failures:**
- Missing NPI for rendering provider
- Invalid ICD-10 code (code expired or not valid for date of service)
- Missing prior authorization for referral-required services
- Subscriber ID format mismatch

**Fix:**
- These are usually data issues, not system issues
- The claims queue to the `claim.validation_failed` event
- Billing team handles these via the admin portal
- If there's a spike in validation failures, check if a payer changed requirements

### 5. Memory Pressure on Claims Service

**Check:**
```bash
# Check memory usage
kubectl top pods -n production -l app=claims-service

# Check for OOM kills
kubectl get events -n production --field-selector reason=OOMKilled | grep claims
```

**Fix:**
```bash
# If OOM, increase memory limits temporarily
kubectl set resources deployment/claims-service -n production \
  --limits=memory=2Gi --requests=memory=1Gi

# Then investigate the root cause (memory leak, large batch, etc.)
```

## Recovery: Reprocessing Stuck Claims

After resolving the root cause, stuck claims need to be reprocessed:

```bash
# Find stuck claims
kubectl exec -n production deployment/claims-service -- \
  node -e "
    const db = require('./db');
    db.query(\"SELECT claim_id, status, updated_at FROM claims WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '30 minutes'\")
      .then(r => { console.log(JSON.stringify(r.rows, null, 2)); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  "
```

```bash
# Reset stuck claims to 'pending' for reprocessing
# WARNING: Only do this after confirming the root cause is resolved
kubectl exec -n production deployment/claims-service -- \
  node -e "
    const db = require('./db');
    db.query(\"UPDATE claims SET status = 'pending', updated_at = NOW(), notes = notes || ARRAY['Reset from processing by on-call - ' || NOW()::text] WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '30 minutes'\")
      .then(r => { console.log('Reset', r.rowCount, 'claims'); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  "
```

## Prevention

- Circuit breaker pattern on clearinghouse calls (already implemented)
- Dead letter queue monitoring with alerts (threshold: 10 messages)
- Database connection pool exhaustion alerts
- Claims processing SLA monitoring (95th percentile < 5 minutes)

## Escalation

If unable to resolve within 1 hour:
1. Page the Claims Service owner (Priya Sharma - PagerDuty)
2. If database-related, contact Platform Team (Tom Kowalski)
3. If clearinghouse-related, open a support ticket with Change Healthcare
