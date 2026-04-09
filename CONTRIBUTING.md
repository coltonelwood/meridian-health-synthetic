# Contributing to the Meridian Health Platform

Thank you for contributing to the Meridian Health Platform! This document outlines our development processes and standards.

> **Note**: This guide is primarily for internal Meridian Health Technologies employees and contractors. External contributions are not accepted at this time.

<!-- TODO: This doc was written when we were ~50 people. We're 180+ now and some of
     these processes don't scale. Update after the eng reorg in Q2 2025. -->

## Getting Started

1. Make sure you've completed IT onboarding and have access to:
   - GitHub (`meridian-health` org)
   - Jira (`PLAT`, `CLAIMS`, `EHR`, `SCHED` boards)
   - Slack (`#platform-eng`, `#team-*` channels)
   - AWS Console (dev account)
   - Datadog
   - PagerDuty (if you're on-call eligible)

2. Set up your development environment following the [README](README.md).
   - If you run into issues, ask in **#platform-eng** on Slack.
   - There's also a (somewhat outdated) [Local Setup Guide](docs/guides/local-setup.md).

3. Familiarize yourself with our [Architecture Decision Records](docs/adr/).

## Development Workflow

### Branch Naming

Use the following format for branch names:

```
<type>/<jira-ticket>-<short-description>

Examples:
  feature/PLAT-1234-add-bulk-export
  fix/CLAIMS-567-edi-parsing-error
  chore/PLAT-890-upgrade-typescript
  hotfix/PLAT-999-auth-token-expiry
```

Valid types: `feature`, `fix`, `chore`, `hotfix`, `refactor`, `docs`, `test`

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]

Examples:
  feat(claims): add ERA 835 parsing support
  fix(ehr-gateway): handle null patient identifiers in ADT messages
  chore(deps): bump @types/node to 18.19.14
  refactor(auth): extract token validation into shared middleware
```

Valid scopes: `auth`, `claims`, `ehr-gateway`, `scheduling`, `analytics`, `doc-service`, `notifications`, `common`, `db`, `fhir-client`, `infra`, `ci`, `deps`

### Pull Request Process

1. **Create a branch** from `main` (or `develop` if working on a release branch).
   <!-- FIXME: We switched from gitflow (develop -> main) to trunk-based development
        in Q1 2025 but some teams are still using develop. We need to standardize. -->

2. **Write your code** following our coding standards (see below).

3. **Write tests** -- all new code should have tests. See the testing section below.

4. **Open a PR** using the PR template. Fill out all sections, including the HIPAA compliance checklist.

5. **Get reviews**:
   - All PRs require at least **2 approving reviews**.
   - One reviewer should be from the CODEOWNERS for the affected files.
   - For changes touching PHI-handling code, you need a review from someone with HIPAA training (anyone on the `@meridian/hipaa-reviewers` team).
   <!-- The old process required @david.chen to review every PR touching the auth service.
        We've relaxed this -- any platform-core member can review auth PRs now. -->

6. **Ensure CI passes** -- all checks must be green before merging.

7. **Squash and merge** -- we use squash merges to keep the main branch history clean.
   - Exception: large features with meaningful commit history can use merge commits with team lead approval.

### Code Review Guidelines

- Be respectful and constructive.
- Focus on:
  - Correctness and edge cases
  - Security implications (especially for auth, PHI handling)
  - Performance (especially for claims processing hot paths)
  - Test coverage
  - HIPAA compliance (audit logging, data encryption, access controls)
- Avoid bikeshedding on style -- that's what Prettier and ESLint are for.
- Use GitHub's "suggestion" feature for small changes.
- If a review thread is getting long, take it to Slack or a quick call.

## Coding Standards

### TypeScript

- We use TypeScript for all Node.js services.
- Strict mode is enabled (`strict: true` in tsconfig).
- Prefer `interface` over `type` for object shapes (team convention, not a hill to die on).
- Use `type` for unions, intersections, and utility types.
- No `any` in production code (use `unknown` and narrow with type guards).
  - Exceptions can be made with `// eslint-disable-next-line` and a JIRA ticket.
- Use `@ts-expect-error` with a description instead of `@ts-ignore`.

### API Design

- All REST APIs should follow our [API Design Guide](docs/guides/api-design.md).
- Use OpenAPI 3.0 specs for documentation.
- Standard response format:
  ```json
  {
    "data": { ... },
    "meta": { "requestId": "...", "timestamp": "..." },
    "errors": [ { "code": "...", "message": "...", "field": "..." } ]
  }
  ```
- Use proper HTTP status codes (don't return 200 with an error body).
- All endpoints must include HIPAA audit logging via `@meridian/hipaa-audit`.

### Database

- Use migrations for all schema changes (never modify the DB directly).
- Migration files go in `services/<service>/migrations/`.
- Name migrations with timestamps: `20240115120000_add_claim_status_index.ts`
- Always include a `down` migration for rollbacks.
- Test migrations against a copy of staging data before deploying.

### Testing

- **Unit tests**: Test individual functions and classes in isolation. Mock external dependencies.
- **Integration tests**: Test service endpoints with real database connections. Use the `*.integration.ts` suffix.
- **E2E tests**: Test full user workflows. Written in Playwright.

Minimum coverage requirements (we're working on getting back to these):
- Branches: 65%
- Functions: 70%
- Lines: 75%
- Statements: 75%

<!-- These used to be enforced in CI but we turned off the check during the
     claims migration. It's "temporary". That was 6 months ago. -->

### HIPAA Compliance

All code changes must consider HIPAA implications:

- **PHI Data**: Never log PHI. Use the redaction utilities in `@meridian/common`.
- **Audit Logging**: All access to PHI must be logged via `@meridian/hipaa-audit`.
- **Encryption**: PHI at rest must be encrypted. Use the encryption helpers in `@meridian/db`.
- **Access Control**: All endpoints handling PHI must verify user authorization.
- **Data Retention**: Follow retention policies defined in `config/data-retention.yml`.

## Reporting Issues

- **Bugs**: File in Jira under the appropriate project board.
- **Security Issues**: Report via the **#security-incidents** Slack channel or email security@meridianhealth.io. Do NOT file security issues in Jira.
- **On-call Issues**: Check the [Incident Response Runbook](docs/runbooks/incident-response.md) and page the appropriate team via PagerDuty.

## Communication

- **#platform-eng** -- General engineering discussion
- **#platform-eng-pr** -- PR notifications (via GitHub integration)
- **#incidents** -- Active incident communication
- **#deploys** -- Deployment notifications
- **#team-claims** / **#team-integrations** / **#team-patient-exp** / **#team-data-ml** / **#team-platform-core** -- Team-specific channels
- **#random** -- Cat pictures and hot takes about JavaScript frameworks

## Release Process

<!-- This section is outdated. We moved from manual releases to automated releases
     in Q4 2024. Keeping the old process documented just in case.
     New process: merge to main -> auto-deploy to staging -> manual promotion to prod -->

~~Releases follow semantic versioning. The release manager (rotates weekly) is responsible for:~~

1. ~~Creating a release branch from `develop`~~
2. ~~Running the release checklist~~
3. ~~Deploying to staging for validation~~
4. ~~Getting sign-off from QA~~
5. ~~Merging to `main` and tagging~~
6. ~~Deploying to production~~

**Updated process**: We now use trunk-based development. Merging to `main` triggers an automatic deployment to staging. Production deployments are triggered manually via the `deploy-prod` GitHub Actions workflow and require approval from a team lead.

---

_Questions? Reach out in **#platform-eng** or DM @david.chen (Engineering Manager) or @sarah.martinez (Staff Engineer)._
