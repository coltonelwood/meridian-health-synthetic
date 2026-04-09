## Summary

<!-- Describe what this PR does and why. Link to the Jira ticket. -->

**Jira Ticket**: [PLAT-XXXX](https://meridianhealth.atlassian.net/browse/PLAT-XXXX)

### Changes

- 

### Motivation

<!-- Why is this change needed? What problem does it solve? -->

## Type of Change

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Refactoring (no functional changes)
- [ ] Documentation update
- [ ] Infrastructure / CI change
- [ ] Database migration
- [ ] Dependency update

## Testing

### How was this tested?

<!-- Describe the tests you ran and how to reproduce them. -->

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

### Test commands

```bash
# Commands to run to test this change
npm run test:unit -- --testPathPattern=<path>
```

## Screenshots / Logs

<!-- If applicable, add screenshots or relevant log output. -->
<!-- IMPORTANT: Redact any PHI from screenshots or logs before posting! -->

## Database Changes

<!-- If this PR includes database changes, fill out this section. Otherwise, delete it. -->

- [ ] Migration file(s) included
- [ ] `down` migration tested and works
- [ ] Migration tested against staging-like data volume
- [ ] No destructive changes to existing data
- [ ] Indexes added for new query patterns

## API Changes

<!-- If this PR changes any API endpoints, fill out this section. Otherwise, delete it. -->

- [ ] OpenAPI spec updated
- [ ] Backward compatible (existing clients won't break)
- [ ] API versioning considered
- [ ] Error responses follow standard format

---

## HIPAA Compliance Checklist

<!-- ALL PRs must complete this checklist. This is required by our compliance policy. -->
<!-- If a checkbox doesn't apply, check it and note "N/A" next to it. -->

### Data Handling

- [ ] This change does **NOT** log any Protected Health Information (PHI)
- [ ] This change does **NOT** expose PHI in error messages or API responses beyond what is necessary
- [ ] PHI at rest is encrypted using approved encryption methods
- [ ] PHI in transit uses TLS 1.2+

### Access Control

- [ ] Appropriate authentication is required for all new endpoints
- [ ] Authorization checks verify the user has access to the requested resource
- [ ] Role-Based Access Control (RBAC) is properly enforced
- [ ] No hardcoded credentials, tokens, or secrets

### Audit Logging

- [ ] All access to PHI is logged via `@meridian/hipaa-audit`
- [ ] Audit log entries include: who, what, when, where, outcome
- [ ] Audit logs do **NOT** contain PHI themselves (use resource IDs, not content)

### Data Retention & Disposal

- [ ] Data retention policies are respected (see `config/data-retention.yml`)
- [ ] Temporary files containing PHI are securely deleted after use
- [ ] Database queries don't inadvertently return more PHI than needed

### General Security

- [ ] No SQL injection vulnerabilities (parameterized queries used)
- [ ] Input validation implemented for all user-provided data
- [ ] No cross-site scripting (XSS) vulnerabilities
- [ ] Dependencies are free of known high/critical vulnerabilities
- [ ] Secrets are stored in environment variables or secrets manager, not in code

---

## Reviewer Notes

<!-- Anything specific you'd like reviewers to focus on? -->

<!-- NOTE: All PRs require 2 approving reviews. PRs touching auth/ or PHI-handling
     code require a review from @meridian/security-reviewers. See CODEOWNERS. -->

## Pre-merge Checklist

- [ ] PR title follows conventional commit format
- [ ] All CI checks pass
- [ ] Required reviews obtained
- [ ] No merge conflicts
- [ ] Documentation updated (if applicable)
