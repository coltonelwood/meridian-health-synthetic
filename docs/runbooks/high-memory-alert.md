# Runbook: High Memory Alert

> **Last updated:** 2025-01
> **Owner:** Platform Team
> **Alert:** `pod_memory_usage_high` (Datadog -> PagerDuty)
> **Threshold:** Pod memory > 85% of limit for 5 minutes

## Quick Assessment

```bash
# 1. Which pods are affected?
kubectl top pods -n production --sort-by=memory | head -20

# 2. Check for OOM kills in the last hour
kubectl get events -n production --field-selector reason=OOMKilled --sort-by='.lastTimestamp' | tail -10

# 3. Check the specific service's memory trend in Datadog
# Dashboard: https://app.datadoghq.com/dashboard/k8s-resource-usage
```

## Service-Specific Guidance

### Node.js Services (auth, patient, documents, comms, eligibility)

**Common causes:**
- Memory leak in request handlers (often from unclosed database connections)
- Large JSON payloads being buffered in memory
- Event listener leak (listeners added per request but never removed)
- V8 heap growing due to long-lived objects in cache

**Diagnostic commands:**
```bash
# Check heap statistics
kubectl exec -n production deployment/<service-name> -- \
  node -e "console.log(JSON.stringify(process.memoryUsage(), null, 2))"

# Get heap snapshot (if the service exposes /debug/heap)
# WARNING: This will pause the process for several seconds
curl -o heap.json http://<service>:8080/debug/heap
```

**Quick fix:**
```bash
# Rolling restart (no downtime with multiple replicas)
kubectl rollout restart deployment/<service-name> -n production
```

**If it recurs after restart, likely a leak. Create a Jira ticket for investigation.**

### Python Services (billing, claims, analytics)

**Common causes:**
- Large Pandas DataFrames held in memory (analytics-service)
- Uncollected circular references
- Large batch processing without streaming
- SQLAlchemy session leak

**Diagnostic commands:**
```bash
# Check Python process memory
kubectl exec -n production deployment/<service-name> -- \
  python -c "
import psutil, os
proc = psutil.Process(os.getpid())
print(f'RSS: {proc.memory_info().rss / 1024 / 1024:.1f} MB')
print(f'VMS: {proc.memory_info().vms / 1024 / 1024:.1f} MB')
"

# Check if it's the analytics service doing a large report
kubectl logs -n production deployment/analytics-service --tail=50 | grep -i "report\|export\|query"
```

**Quick fix for analytics-service:**
```bash
# If a large report is running, it may complete on its own
# Check the current task:
kubectl logs -n production deployment/analytics-service --tail=20

# If stuck, restart:
kubectl rollout restart deployment/analytics-service -n production
```

### Go Services (scheduling, audit)

**Common causes:**
- Goroutine leak (most common)
- Large response bodies being fully buffered
- Pprof will tell you exactly what's happening

**Diagnostic commands:**
```bash
# Check goroutine count (if pprof endpoint is exposed)
curl -s http://<service>:6060/debug/pprof/goroutine?debug=1 | head -5

# Get full memory profile
curl -o mem.pprof http://<service>:6060/debug/pprof/heap
# Analyze locally: go tool pprof mem.pprof
```

**If goroutine count is >10,000, likely a goroutine leak. Restart and create a ticket.**

### Java Service (fhir-facade)

**Common causes:**
- JVM heap sized too small for Bulk FHIR exports
- GC pressure from HAPI FHIR object creation
- Connection pool exhaustion causing thread accumulation

**Diagnostic commands:**
```bash
# Check JVM memory
kubectl exec -n production deployment/fhir-facade -- \
  jcmd 1 GC.heap_info

# Force GC (may temporarily fix)
kubectl exec -n production deployment/fhir-facade -- \
  jcmd 1 GC.run

# Check thread count
kubectl exec -n production deployment/fhir-facade -- \
  jcmd 1 Thread.print | grep "java.lang.Thread.State" | sort | uniq -c
```

**Quick fix:**
```bash
kubectl rollout restart deployment/fhir-facade -n production
```

## Scaling Up

If the service legitimately needs more memory (e.g., during batch processing):

```bash
# Temporarily increase memory limit
kubectl set resources deployment/<service-name> -n production \
  --limits=memory=<new-limit> --requests=memory=<new-request>

# Example: Increase claims-service from 1Gi to 2Gi
kubectl set resources deployment/claims-service -n production \
  --limits=memory=2Gi --requests=memory=1.5Gi
```

**Remember to revert after the batch completes**, or update the Helm values permanently if this is the new normal.

## When to Escalate

- If the service is OOM-killing repeatedly (>3 times in 1 hour)
- If you suspect a memory leak that wasn't there before (check recent deployments)
- If the issue affects patient-facing services (patient portal, scheduling)
- If you need to increase limits beyond 4Gi (needs capacity planning review)

Contact Platform Team: Tom Kowalski (PagerDuty) or `#platform-team` Slack channel.
