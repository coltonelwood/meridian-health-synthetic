# Deprecated Authentication System

> **DEPRECATED: Original auth system using sessions + cookies. Migrated to JWT-based auth in `services/auth-service`. This code is kept for reference during migration. - Sarah, 2024-01**

## Background

This was the original authentication system used by the patient portal and internal tools. It used Passport.js with two strategies:

1. **Local Strategy** - Email/password authentication with bcrypt hashing
2. **LDAP Strategy** - For internal staff authentication against Active Directory

Sessions were stored in Redis using `connect-redis`, with a 30-minute idle timeout to comply with HIPAA requirements.

## Migration Status

| Component | Migration Status | Notes |
|-----------|-----------------|-------|
| Patient login | Complete | Migrated to JWT + refresh tokens |
| Staff login | Complete | Migrated to OIDC with Azure AD |
| Remember me | Dropped | Security team decided against it |
| Session store | Complete | Now stateless (JWT) with token blacklist |
| Password reset | Complete | New flow uses time-limited magic links |
| MFA | In Progress | TOTP support added, SMS pending |

## Why JWT?

The session-based approach had several issues:
- Redis was a single point of failure for auth
- Horizontal scaling required sticky sessions or shared Redis
- Mobile app couldn't easily use cookie-based auth
- Cross-service authentication was awkward with sessions

See `docs/architecture/adr-004-jwt-auth.md` for the full decision record (if it exists - Derek was supposed to write it).

## Security Notes

- The bcrypt cost factor in this code is 10. The new system uses 12.
- Password history was stored as bcrypt hashes (which is fine).
- The LDAP bind password was in an environment variable (also fine).
- The "remember me" token used `crypto.randomBytes(32)` which is secure, but the token was stored unhashed in the database (not great).
