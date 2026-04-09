# Database Failover Runbook

> **Last updated:** 2024-11
> **Owner:** Platform Team
> **Severity:** SEV-1 (if unplanned) / SEV-3 (if planned maintenance)

## Overview

Our primary database is PostgreSQL 15 on AWS RDS Multi-AZ. In a failover event, RDS automatically promotes the standby replica in the other AZ. This runbook covers both automatic and manual failover procedures.

## Architecture

```
Primary (us-east-1a)          Standby (us-east-1b)
+-------------------+        +-------------------+
| RDS PostgreSQL    |  sync  | RDS PostgreSQL    |
| Writer Instance   | -----> | Reader Instance   |
| db.r6g.2xlarge    |        | db.r6g.2xlarge    |
+-------------------+        +-------------------+
         |
         | async
         v
+-------------------+
| Read Replica      |
| (Analytics)       |
| db.r6g.xlarge     |
+-------------------+
```

_[Screenshot of RDS console showing Multi-AZ configuration should be here - not included in archived version]_

## Automatic Failover

RDS will automatically failover when:
- The primary instance fails
- The primary AZ becomes unavailable
- The primary instance is rebooted with the "failover" option
- The primary instance type is changed

**Expected downtime:** 60-120 seconds for DNS failover

### What Happens During Automatic Failover

1. RDS detects the primary is unhealthy
2. Standby is promoted to primary
3. DNS endpoint (`meridian-prod.cluster-xyz.us-east-1.rds.amazonaws.com`) is updated
4. Application connection pools detect the change and reconnect
5. A new standby is created from the promoted primary

### What You Need to Do

1. **Monitor the failover in RDS console**
   - Go to RDS > Databases > meridian-prod
   - Check "Events" tab for failover events

2. **Verify application connectivity**
   ```bash
   # Check if services reconnected
   kubectl logs -n production deployment/patient-service --tail=50 | grep -i "database\|connection\|reconnect"

   # Check for connection errors across all services
   kubectl logs -n production -l app.kubernetes.io/part-of=meridian --tail=100 | grep -i "ECONNREFUSED\|connection refused\|connection reset"
   ```

3. **Verify data integrity**
   ```sql
   -- Check replication lag (should be 0 after failover completes)
   SELECT * FROM pg_stat_replication;

   -- Check for in-flight transactions that may have been lost
   SELECT count(*) FROM claims WHERE status = 'processing'
     AND updated_at < NOW() - INTERVAL '5 minutes';
   ```

4. **Check the analytics read replica**
   - It may experience brief replication lag after failover
   - Check: `SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;`

5. **Restart any services showing persistent connection errors**
   ```bash
   kubectl rollout restart deployment/<service-name> -n production
   ```

## Manual Failover (Planned)

For planned maintenance windows:

### Pre-Failover Checklist

- [ ] Schedule maintenance window (ideally Sunday 2-4 AM ET)
- [ ] Notify stakeholders via `#engineering` Slack channel (48 hours notice)
- [ ] Update status page with planned maintenance notice
- [ ] Verify standby replica is in sync
- [ ] Verify application health before starting

### Failover Steps

1. **Reduce traffic** (optional, for extra safety)
   ```bash
   # Scale down non-critical batch jobs
   kubectl scale deployment/analytics-service --replicas=0 -n production
   ```

2. **Initiate failover via AWS CLI**
   ```bash
   aws rds reboot-db-instance \
     --db-instance-identifier meridian-prod \
     --force-failover
   ```

3. **Monitor failover**
   ```bash
   # Watch RDS events
   aws rds describe-events \
     --source-identifier meridian-prod \
     --source-type db-instance \
     --duration 15
   ```

4. **Verify services reconnect** (see automatic failover steps above)

5. **Scale services back up**
   ```bash
   kubectl scale deployment/analytics-service --replicas=2 -n production
   ```

6. **Post-failover validation**
   - [ ] All services healthy in Datadog
   - [ ] No elevated error rates
   - [ ] API response times nominal
   - [ ] Cron jobs executing properly
   - [ ] Read replica replication lag < 1 second

## Troubleshooting

### Services won't reconnect after failover

**Symptom:** Connection timeout errors persist after DNS propagation

**Likely cause:** Connection pool holding stale connections

**Fix:**
```bash
# Rolling restart of affected service
kubectl rollout restart deployment/<service-name> -n production

# If urgent, delete pods directly (they'll be recreated)
kubectl delete pod -l app=<service-name> -n production
```

### High replication lag on analytics replica

**Symptom:** Analytics queries returning stale data, replication lag > 30 seconds

**Likely cause:** Large write volume during/after failover

**Fix:** Usually resolves on its own. If persistent:
```bash
# Check what's causing the lag
aws rds describe-db-instances \
  --db-instance-identifier meridian-prod-analytics-replica \
  --query 'DBInstances[0].StatusInfos'
```

### Claims stuck in "processing" state after failover

**Symptom:** Claims not advancing through the pipeline

**Likely cause:** In-flight transactions lost during failover

**Fix:** See the `claim-processing-stuck.md` runbook for recovery steps.

## Connection Configuration

All services should have these connection pool settings for failover resilience:

```yaml
# Recommended PostgreSQL connection pool settings
database:
  pool:
    min: 2
    max: 20
    idleTimeoutMillis: 30000
    connectionTimeoutMillis: 5000
    # Critical for failover:
    reapIntervalMillis: 1000
    validateOnBorrow: true
```

## Emergency Contacts

- **AWS Support:** Enterprise support case via console (15-min response for critical)
- **Database DBA (contractor):** Alex Drummond - 617-555-9010
- **Platform Team Lead:** Tom Kowalski - 617-555-9011
