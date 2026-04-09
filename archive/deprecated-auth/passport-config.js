/**
 * Passport.js Authentication Configuration (DEPRECATED)
 *
 * DEPRECATED: Migrated to JWT-based auth in services/auth-service.
 * Kept for reference during migration.
 *
 * Strategies:
 *   - Local: Email/password for patients
 *   - LDAP: Active Directory for internal staff
 *
 * Original author: Sarah Okonkwo
 * Created: 2019-04
 * Last modified: 2024-01
 */

'use strict';

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const LdapStrategy = require('passport-ldapauth');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// In production these were actual database/service calls
// const db = require('../db');
// const User = require('../models/user');
// const AuditLog = require('../services/audit-log');

const BCRYPT_COST_FACTOR = 10; // New system uses 12
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const PASSWORD_HISTORY_LENGTH = 6;

// ============================================================
// Serialization
// ============================================================

passport.serializeUser(function (user, done) {
  // Only store the user ID in the session - never store PHI in the session
  done(null, {
    id: user.id,
    type: user.type // 'patient' or 'staff'
  });
});

passport.deserializeUser(function (sessionData, done) {
  // Look up the full user object on each request
  // This was actually a performance bottleneck - every single request
  // hit the database. The new JWT system avoids this.

  // In production:
  // User.findById(sessionData.id)
  //   .then(user => {
  //     if (!user) return done(null, false);
  //     if (user.accountLocked) return done(null, false);
  //     done(null, user);
  //   })
  //   .catch(done);

  done(null, null); // Placeholder
});

// ============================================================
// Local Strategy (Patient Authentication)
// ============================================================

passport.use('local', new LocalStrategy(
  {
    usernameField: 'email',
    passwordField: 'password',
    passReqToCallback: true
  },
  function (req, email, password, done) {
    // Normalize email
    email = email.toLowerCase().trim();

    // In production, this looked up the patient user record
    // var user = await User.findByEmail(email);

    // Simulated lookup for reference
    var user = null; // Would be from database

    if (!user) {
      // Don't reveal whether the email exists - security best practice
      // But we log it internally for security monitoring
      logFailedLogin(email, req.ip, 'email_not_found');
      return done(null, false, { message: 'Invalid email or password.' });
    }

    // Check account lockout
    if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      var lockoutEnd = new Date(user.lastFailedLogin);
      lockoutEnd.setMinutes(lockoutEnd.getMinutes() + LOCKOUT_DURATION_MINUTES);

      if (new Date() < lockoutEnd) {
        logFailedLogin(email, req.ip, 'account_locked');
        return done(null, false, {
          message: 'Your account has been temporarily locked due to too many failed login attempts. Please try again in ' + LOCKOUT_DURATION_MINUTES + ' minutes.'
        });
      } else {
        // Lockout period has passed - reset attempts
        // User.resetLoginAttempts(user.id);
        user.loginAttempts = 0;
      }
    }

    // Verify password
    bcrypt.compare(password, user.passwordHash, function (err, isMatch) {
      if (err) {
        return done(err);
      }

      if (!isMatch) {
        // Increment failed login attempts
        // User.incrementLoginAttempts(user.id);
        logFailedLogin(email, req.ip, 'wrong_password');

        var attemptsRemaining = MAX_LOGIN_ATTEMPTS - (user.loginAttempts + 1);
        if (attemptsRemaining <= 2 && attemptsRemaining > 0) {
          return done(null, false, {
            message: 'Invalid email or password. ' + attemptsRemaining + ' attempts remaining before account lockout.'
          });
        }

        return done(null, false, { message: 'Invalid email or password.' });
      }

      // Check if password has expired (90-day policy for HIPAA)
      if (user.passwordChangedAt) {
        var daysSinceChange = Math.floor(
          (Date.now() - new Date(user.passwordChangedAt).getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysSinceChange > 90) {
          // Don't block login, but flag that password needs changing
          user.mustChangePassword = true;
        }
      }

      // Check if email is verified
      if (!user.emailVerified) {
        user.pendingVerification = true;
      }

      // Reset login attempts on successful login
      // User.resetLoginAttempts(user.id);

      // Log successful login
      logSuccessfulLogin(user.id, email, req.ip);

      return done(null, user);
    });
  }
));

// ============================================================
// LDAP Strategy (Staff Authentication)
// ============================================================

var ldapOptions = {
  server: {
    url: process.env.LDAP_URL || 'ldaps://ad.meridianhealth.local:636',
    bindDN: process.env.LDAP_BIND_DN || 'cn=svc-portal,ou=Service Accounts,dc=meridianhealth,dc=local',
    bindCredentials: process.env.LDAP_BIND_PASSWORD || '',
    searchBase: 'ou=Employees,dc=meridianhealth,dc=local',
    searchFilter: '(sAMAccountName={{username}})',
    searchAttributes: ['sAMAccountName', 'mail', 'givenName', 'sn', 'memberOf', 'employeeID'],
    tlsOptions: {
      // In production, we had proper CA certificates configured
      rejectUnauthorized: process.env.NODE_ENV === 'production'
    },
    reconnect: true
  },
  credentialsLookup: function (req) {
    // LDAP strategy needs username/password from request
    return {
      username: req.body.username,
      password: req.body.password
    };
  }
};

passport.use('ldap', new LdapStrategy(ldapOptions, function (req, user, done) {
  // Map LDAP user to our internal user format
  var mappedUser = {
    id: 'staff-' + user.employeeID,
    type: 'staff',
    username: user.sAMAccountName,
    email: user.mail,
    firstName: user.givenName,
    lastName: user.sn,
    roles: mapLdapGroupsToRoles(user.memberOf || []),
    source: 'ldap'
  };

  // Check if user has appropriate group membership
  if (mappedUser.roles.length === 0) {
    logFailedLogin(user.sAMAccountName, req.ip, 'no_portal_access_group');
    return done(null, false, {
      message: 'You do not have access to the patient portal. Please contact IT support.'
    });
  }

  // Log LDAP authentication
  logSuccessfulLogin(mappedUser.id, mappedUser.username, req.ip);

  return done(null, mappedUser);
}));

// ============================================================
// Remember Me functionality
// ============================================================

/**
 * Generate a "remember me" token and store it.
 *
 * Security note: In hindsight, we should have stored these tokens
 * as hashes, not plaintext. If the database were compromised, an
 * attacker could use these tokens directly. The new JWT system
 * uses refresh tokens with proper hashing.
 *
 * @param {string} userId
 * @param {Function} callback
 */
function generateRememberMeToken(userId, callback) {
  var token = crypto.randomBytes(32).toString('hex');
  var expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days

  // In production:
  // db.query(
  //   'INSERT INTO remember_me_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
  //   [userId, token, expiresAt]  // BUG: token stored unhashed!
  // );

  callback(null, token);
}

/**
 * Consume a "remember me" token (one-time use).
 *
 * @param {string} token
 * @param {Function} callback
 */
function consumeRememberMeToken(token, callback) {
  // In production:
  // db.query(
  //   'DELETE FROM remember_me_tokens WHERE token = $1 AND expires_at > NOW() RETURNING user_id',
  //   [token]
  // );
  //
  // The DELETE ensures the token can only be used once.
  // If it was already consumed, no rows returned = invalid token.

  callback(null, null); // Placeholder
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Map Active Directory group memberships to application roles.
 */
function mapLdapGroupsToRoles(memberOf) {
  var roles = [];

  var groupMapping = {
    'CN=Portal-Admins,OU=Groups,DC=meridianhealth,DC=local': 'admin',
    'CN=Portal-Providers,OU=Groups,DC=meridianhealth,DC=local': 'provider',
    'CN=Portal-Billing,OU=Groups,DC=meridianhealth,DC=local': 'billing',
    'CN=Portal-FrontDesk,OU=Groups,DC=meridianhealth,DC=local': 'front_desk',
    'CN=Portal-Nurses,OU=Groups,DC=meridianhealth,DC=local': 'nurse',
    'CN=Portal-MedRecords,OU=Groups,DC=meridianhealth,DC=local': 'medical_records',
    'CN=Portal-Compliance,OU=Groups,DC=meridianhealth,DC=local': 'compliance',
  };

  memberOf.forEach(function (group) {
    if (groupMapping[group]) {
      roles.push(groupMapping[group]);
    }
  });

  return roles;
}

/**
 * Log failed login attempt for security monitoring.
 * These logs are monitored by our SIEM (Splunk).
 */
function logFailedLogin(identifier, ipAddress, reason) {
  var entry = {
    event: 'LOGIN_FAILED',
    timestamp: new Date().toISOString(),
    identifier: identifier,
    ip: ipAddress,
    reason: reason,
    // HIPAA: Failed login attempts must be logged and monitored
    severity: 'WARN'
  };

  console.log('SECURITY_AUDIT:', JSON.stringify(entry));

  // In production, also sent to:
  // - Splunk via syslog
  // - PagerDuty if brute force detected (>20 attempts in 5 min from same IP)
  // AuditLog.write(entry);
}

/**
 * Log successful login for audit trail.
 */
function logSuccessfulLogin(userId, identifier, ipAddress) {
  var entry = {
    event: 'LOGIN_SUCCESS',
    timestamp: new Date().toISOString(),
    userId: userId,
    identifier: identifier,
    ip: ipAddress,
    severity: 'INFO'
  };

  console.log('SECURITY_AUDIT:', JSON.stringify(entry));
  // AuditLog.write(entry);
}

/**
 * Hash a password with bcrypt.
 * Used during registration and password changes.
 */
function hashPassword(plaintext, callback) {
  bcrypt.hash(plaintext, BCRYPT_COST_FACTOR, callback);
}

/**
 * Validate password against policy.
 *
 * HIPAA doesn't specify exact password requirements, but
 * our security team settled on:
 * - Minimum 12 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 number
 * - At least 1 special character
 * - Cannot be any of the last 6 passwords
 * - Cannot contain the user's name or email
 */
function validatePasswordPolicy(password, user) {
  var errors = [];

  if (password.length < 12) {
    errors.push('Password must be at least 12 characters long.');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter.');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter.');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number.');
  }

  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character.');
  }

  // Check for user info in password
  if (user) {
    var lowerPassword = password.toLowerCase();
    if (user.firstName && lowerPassword.includes(user.firstName.toLowerCase())) {
      errors.push('Password cannot contain your first name.');
    }
    if (user.lastName && lowerPassword.includes(user.lastName.toLowerCase())) {
      errors.push('Password cannot contain your last name.');
    }
    if (user.email) {
      var emailLocal = user.email.split('@')[0].toLowerCase();
      if (lowerPassword.includes(emailLocal)) {
        errors.push('Password cannot contain your email address.');
      }
    }
  }

  return errors;
}

module.exports = {
  passport: passport,
  generateRememberMeToken: generateRememberMeToken,
  consumeRememberMeToken: consumeRememberMeToken,
  hashPassword: hashPassword,
  validatePasswordPolicy: validatePasswordPolicy
};
