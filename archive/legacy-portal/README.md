# Legacy Patient Portal (DEPRECATED)

> **DEPRECATED: This was the original patient portal built in 2019. Replaced by the new React-based portal in Q2 2024. Keeping for reference only. DO NOT USE.**

## History

This portal was the first patient-facing application for Meridian Health Technologies. It was built as a monolithic Express.js app with server-rendered Pug templates and jQuery for interactivity. Authentication was session-based using Passport.js with a Redis session store.

The portal was retired in June 2024 after a 3-month migration to the new React SPA (`services/patient-portal`). All patient data was migrated, and the old endpoints were sunset with a 90-day deprecation notice.

## Why We Kept This

- Some older integration partners still reference endpoints from this portal in their documentation
- The claim display logic in `routes.js` has some edge cases that were ported to the new system and may need cross-referencing
- Historical audit logs reference routes defined here

## Known Issues (at time of deprecation)

- jQuery 2.x had known XSS vulnerabilities (never patched)
- Session fixation vulnerability was identified but never fixed since we were already migrating
- Bootstrap 3 had accessibility issues that were never resolved
- PDF generation for statements occasionally produced blank pages

## Contact

If you have questions about this code, reach out to **Derek Simmons** (Platform Team) who led the migration.
