# Incident Response Runbook

> **Last updated:** 2025-01
> **Owner:** Platform Team / On-Call Engineering
> **PagerDuty Service:** `meridian-platform`

## Severity Levels

| Severity | Description | Response Time | Example |
|----------|-------------|---------------|---------|
| SEV-1 | System-wide outage, data breach, or PHI exposure | 15 minutes | All services down, database compromised |
| SEV-2 | Major feature degraded, significant user impact | 30 minutes | Claims processing stopped, patient portal down |
| SEV-3 | Minor feature degraded, limited user impact | 2 hours | Notification delays, slow report generation |
| SEV-4 | Cosmetic issue, no user impact | Next business day | Dashboard formatting, non-critical bug |

## Escalation Matrix

### SEV-1

1. **On-Call Engineer** (PagerDuty primary) - Responds within 15 min
2. **Engineering Manager** (auto-escalated at 20 min) - Janet Liu (617-555-9001)
3. **VP Engineering** (auto-escalated at 30 min) - Janet Liu
4. **CTO** (manual escalation if needed) - Mark Rivera (617-555-9002)
5. **HIPAA Security Officer** (if PHI involved) - David Park (617-555-9003)
6. **Legal/Compliance** (if data breach) - Compliance Team Slack channel

### SEV-2

1. **On-Call Engineer** (PagerDuty primary) - Responds within 30 min
2. **Service Owner** (see service ownership table) - Notified via Slack
3. **Engineering Manager** (escalated at 1 hour if unresolved)

### SEV-3/SEV-4

1. **On-Call Engineer** - Acknowledges and creates Jira ticket
2. **Service Owner** - Triages during business hours

## Communication Templates

### Internal Slack (#incidents channel)

```
:rotating_light: INCIDENT DECLARED - SEV-[X]
Title: [Brief description]
Impact: [What users/services are affected]
Status: Investigating
Incident Commander: [Your name]
War Room: [Zoom link or Slack huddle]
Status Page: [Updated? Y/N]
```

### Status Page Update (statuspage.meridianhealth.io)

```
Title: [Service] - [Degraded Performance / Partial Outage / Major Outage]

[Time] - We are investigating reports of [issue description].
We will provide an update within 30 minutes.
```

### Customer Communication (for SEV-1/SEV-2)

```
Subject: Service Disruption - Meridian Health Platform

We are currently experiencing a disruption to [affected services].
Our engineering team is actively working to resolve this issue.

Impact: [What functionality is affected]
Workaround: [If applicable]
Estimated resolution: [Time or "We will update within X minutes"]

We apologize for the inconvenience and will provide updates as they become available.
```

## Response Procedure

### 1. Acknowledge

- [ ] Acknowledge the PagerDuty alert
- [ ] Join the `#incidents` Slack channel
- [ ] Declare the incident with severity level
- [ ] If SEV-1 or SEV-2, start a war room (Zoom link in PagerDuty note)

### 2. Assess

- [ ] Check Datadog dashboards: https://app.datadoghq.com/dashboard/meridian-overview
- [ ] Check service health: `kubectl get pods -n production`
- [ ] Check recent deployments: `kubectl rollout history -n production`
- [ ] Review error logs in Datadog Logs
- [ ] Check AWS Health Dashboard for infrastructure issues
- [ ] Check third-party status pages (Change Healthcare, Twilio, etc.)

### 3. Mitigate

- [ ] If caused by a deployment, consider rollback:
  ```
  kubectl rollout undo deployment/<service-name> -n production
  ```
- [ ] If caused by traffic spike, scale up:
  ```
  kubectl scale deployment/<service-name> --replicas=<N> -n production
  ```
- [ ] If database related, check connection pools and active queries
- [ ] If third-party, activate fallback/circuit breaker if available

### 4. Communicate

- [ ] Update `#incidents` channel every 15 minutes (SEV-1) or 30 minutes (SEV-2)
- [ ] Update status page
- [ ] Notify affected customers if SEV-1 or extended SEV-2
- [ ] If PHI involved, notify HIPAA Security Officer IMMEDIATELY

### 5. Resolve

- [ ] Confirm the issue is resolved
- [ ] Update status page to "Resolved"
- [ ] Post final update in `#incidents`
- [ ] Create post-incident Jira ticket for postmortem

### 6. Postmortem

- [ ] Schedule postmortem within 48 hours (SEV-1) or 1 week (SEV-2)
- [ ] Write postmortem using template in `docs/postmortems/`
- [ ] Identify action items and assign owners
- [ ] Share with engineering team

## HIPAA Breach Response

If the incident involves potential exposure of Protected Health Information (PHI):

1. **IMMEDIATELY** notify the HIPAA Security Officer (David Park)
2. **DO NOT** discuss specifics in public Slack channels
3. Move to the private `#security-incidents` channel
4. Document the scope: What PHI was potentially exposed? How many patients?
5. Preserve all evidence (logs, screenshots, access records)
6. The Security Officer will coordinate with Legal/Compliance on:
   - HHS notification requirements (within 60 days for >500 individuals)
   - Individual patient notification
   - State attorney general notification (if required)

## On-Call Schedule

- Primary on-call: Rotates weekly (Mon 9AM to Mon 9AM)
- Secondary on-call: Previous week's primary
- Schedule managed in PagerDuty
- On-call handoff meeting: Monday 9:00 AM ET

## Useful Links

- Datadog: https://app.datadoghq.com/dashboard/meridian-overview
- PagerDuty: https://meridianhealth.pagerduty.com
- Status Page (admin): https://manage.statuspage.io/pages/meridian
- AWS Console: https://console.aws.amazon.com (SSO via Okta)
- ArgoCD: https://argocd.internal.meridianhealth.io
- Runbook index: This directory
