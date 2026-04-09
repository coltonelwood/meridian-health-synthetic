# New Engineer Onboarding Guide

> **Last updated:** 2025-02
> **Owner:** Engineering Management

Welcome to Meridian Health Technologies! This guide will help you get started.

## Week 1: Setup & Orientation

### Day 1: Accounts & Access

Your manager should have requested the following before your start date. If anything is missing, ping `#it-support` on Slack.

- [ ] GitHub access (meridian-health org) - [Request here](https://github.com/orgs/meridian-health) _(link requires VPN)_
- [ ] Jira access - https://meridianhealth.atlassian.net
- [ ] Slack workspace - meridian-health.slack.com
- [ ] AWS SSO via Okta - https://meridianhealth.okta.com
- [ ] Datadog access - Read-only initially, request write via IT
- [ ] PagerDuty account - You'll be added to on-call after 30 days
- [ ] 1Password team vault - For shared credentials (dev only)
- [ ] VPN configuration - Required for internal services

### Day 1-2: Local Development Setup

Follow the [Local Development Setup Guide](./local-dev-setup.md) to get your machine configured. This typically takes 2-4 hours.

### Day 2-3: Architecture Overview

Read these docs in order:

1. [System Overview](../architecture/system-overview.md) - High-level architecture
2. [Data Flow](../architecture/data-flow.md) - How data moves through the system
3. [Tech Stack](../architecture/tech-stack.md) - Technologies we use
4. ADRs in `docs/architecture/adr-*` - Key architectural decisions

### Day 3-5: Domain Knowledge

Healthcare SaaS has a LOT of domain-specific knowledge. Don't worry about memorizing everything - you'll pick it up over time.

**Required reading:**
- [Healthcare Billing 101](https://meridianhealth.notion.so/Healthcare-Billing-101) _(Notion link - may need access request)_
- [HIPAA for Engineers](https://meridianhealth.notion.so/HIPAA-for-Engineers) _(Notion)_
- [FHIR Overview](https://www.hl7.org/fhir/overview.html) _(External)_

**Key terminology to know:**
- **PHI** - Protected Health Information. Anything that identifies a patient + their health data.
- **MRN** - Medical Record Number. Our internal patient identifier.
- **NPI** - National Provider Identifier. 10-digit number for healthcare providers.
- **CPT** - Current Procedural Terminology. Codes for medical procedures.
- **ICD-10** - International Classification of Diseases. Diagnosis codes.
- **EOB** - Explanation of Benefits. Document from insurer explaining what they paid.
- **ERA/835** - Electronic Remittance Advice. Electronic payment notification from payers.
- **EDI 837** - Electronic claim submission format.
- **Clearinghouse** - Intermediary that routes claims between providers and payers.

## Week 2: Hands-On

### Starter Tickets

Your manager will assign you 2-3 starter tickets (labeled `good-first-issue` in Jira). These are intentionally scoped to be small and low-risk.

### Code Review

Start reviewing PRs from your team. This is the fastest way to learn the codebase. Look for PRs labeled `onboarding-friendly`.

### Pair Programming

Schedule 2-3 pairing sessions with team members this week. Ask your manager for suggestions on who to pair with.

## Week 3-4: Contributing

By now you should be:
- [ ] Comfortable with the local dev setup
- [ ] Able to navigate the codebase
- [ ] Submitting PRs for review
- [ ] Participating in code reviews
- [ ] Attending team standups and retros

### First On-Call Shadow

In week 3 or 4, you'll shadow the on-call engineer for a day. This is observational only - you won't be on-call yourself until after 30 days and completing the on-call training.

## Key Contacts

| Role | Person | Slack |
|------|--------|-------|
| VP Engineering | Janet Liu | @janet.liu |
| Platform Team Lead | Tom Kowalski | @tom.k |
| Patient Service Owner | Maria Chen | @maria.c |
| Claims Service Owner | Priya Sharma | @priya.s |
| Scheduling Service Owner | Alex Petrov | @alex.p |
| HIPAA Security Officer | David Park | @david.park |
| DevOps Lead | Sam Nakamura | @sam.n |

## Important Slack Channels

| Channel | Purpose |
|---------|---------|
| `#engineering` | General engineering discussion |
| `#deploys` | Deployment notifications (automated) |
| `#incidents` | Active incidents |
| `#code-review` | PR review requests |
| `#platform-team` | Platform/infrastructure discussion |
| `#billing-ops` | Billing operations |
| `#random` | Non-work chat |

## Development Practices

- **PRs require 1 approval** (2 for services handling PHI)
- **All code must have tests** - Minimum 80% coverage for new code
- **Trunk-based development** - Short-lived feature branches, merge to main
- **CI must pass** before merging (linting, tests, security scan)
- **Deploy via ArgoCD** - Merging to main auto-deploys to staging. Production requires manual promotion.
- **HIPAA training** - Required annually. You'll be enrolled automatically.

## Useful Bookmarks

- ArgoCD: https://argocd.internal.meridianhealth.io
- Datadog: https://app.datadoghq.com/dashboard/meridian-overview
- API Docs: https://api-docs.internal.meridianhealth.io
- Runbooks: `docs/runbooks/` in this repo
- Postmortems: `docs/postmortems/` in this repo
- Design System: https://design.internal.meridianhealth.io _(link broken since domain migration - ask Tom)_

## Questions?

Don't hesitate to ask! There are no dumb questions, especially in healthcare tech where the domain complexity is high. Your team is here to help.

The best place to ask is your team's Slack channel, or DM your onboarding buddy (your manager will assign one).
