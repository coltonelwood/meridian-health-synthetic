/**
 * Meridian Health Technologies - Patient Portal (LEGACY)
 *
 * DEPRECATED: This application has been replaced by the React-based
 * patient portal in services/patient-portal as of Q2 2024.
 *
 * Original author: Derek Simmons
 * Created: March 2019
 * Last modified: June 2024 (shutdown/redirect code added)
 */

'use strict';

const express = require('express');
const path = require('path');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const passport = require('passport');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const compression = require('compression');

const routes = require('./routes');
const passportConfig = require('./passport-config'); // eslint-disable-line no-unused-vars

const app = express();

// View engine setup - Pug (formerly Jade)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Trust proxy for running behind AWS ALB
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // TODO: was never properly configured
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true
  }
}));

// Logging
// NOTE: We had to use combined format because the HIPAA security officer
// wanted full request logging. In hindsight we should have been more careful
// about what we logged - see incident report INC-2023-0847
app.use(morgan('combined', {
  skip: function (req, res) {
    // Don't log health checks - they fill up the logs
    return req.url === '/health' || req.url === '/ready';
  }
}));

app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'meridian-dev-secret-2019'));

// Static files - Bootstrap 3, jQuery 2.x, custom CSS
app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true
}));

// Session configuration
const sessionConfig = {
  store: new RedisStore({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    prefix: 'mht-portal:sess:',
    ttl: 1800, // 30 minutes - HIPAA requirement for auto-logout
    db: 2
  }),
  secret: process.env.SESSION_SECRET || 'meridian-portal-dev-secret',
  name: 'mht.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1800000, // 30 minutes
    sameSite: 'lax'
  }
};

app.use(session(sessionConfig));

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

// Flash messages
app.use(flash());

// CSRF protection
// NOTE: Had to disable for /api/* routes because the mobile app
// couldn't handle CSRF tokens properly. Yes, this is bad.
app.use(csrf({
  cookie: false,
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
  value: function (req) {
    return req.body._csrf || req.headers['x-csrf-token'];
  }
}));

// Make user and flash messages available to all templates
app.use(function (req, res, next) {
  res.locals.user = req.user || null;
  res.locals.messages = {
    success: req.flash('success'),
    error: req.flash('error'),
    warning: req.flash('warning'),
    info: req.flash('info')
  };
  res.locals.csrfToken = req.csrfToken();
  next();
});

// Activity timeout middleware - HIPAA compliance
// Auto-logout after 15 minutes of inactivity
app.use(function (req, res, next) {
  if (req.session && req.session.lastActivity) {
    const elapsed = Date.now() - req.session.lastActivity;
    if (elapsed > 15 * 60 * 1000) {
      req.session.destroy(function (err) {
        if (err) {
          console.error('Failed to destroy expired session:', err);
        }
        return res.redirect('/login?reason=timeout');
      });
      return;
    }
  }
  if (req.session && req.isAuthenticated()) {
    req.session.lastActivity = Date.now();
  }
  next();
});

// Audit logging middleware
// Every authenticated request gets logged for HIPAA compliance
app.use(function (req, res, next) {
  if (req.isAuthenticated() && req.method !== 'OPTIONS') {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      userId: req.user.id,
      mrn: req.user.mrn || 'N/A',
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('user-agent')
    };

    // TODO: This was writing to a local file which was terrible.
    // Should have been sending to a proper audit log service from the start.
    // The new portal uses the centralized audit-service.
    console.log('AUDIT:', JSON.stringify(auditEntry));
  }
  next();
});

// Routes
app.use('/', routes);

// Health check endpoint (no auth required)
app.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    service: 'patient-portal-legacy',
    version: '1.47.2',
    deprecated: true,
    shutdownDate: '2024-06-30'
  });
});

// 404 handler
app.use(function (req, res, next) {
  res.status(404);
  res.render('error', {
    title: 'Page Not Found',
    message: 'The page you requested was not found.',
    error: {}
  });
});

// Error handler
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err.code === 'EBADCSRFTOKEN') {
    req.flash('error', 'Your session has expired. Please try again.');
    return res.redirect('back');
  }

  // Don't leak stack traces in production
  const statusCode = err.status || 500;
  console.error('Unhandled error:', err.stack);

  // Log PHI access errors separately for compliance
  if (err.phiAccess) {
    console.error('PHI_ACCESS_ERROR:', JSON.stringify({
      timestamp: new Date().toISOString(),
      userId: req.user ? req.user.id : 'anonymous',
      error: err.message,
      path: req.path
    }));
  }

  res.status(statusCode);
  res.render('error', {
    title: 'Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : err.message,
    error: process.env.NODE_ENV === 'production' ? {} : err
  });
});

// Server startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('==============================================');
  console.log(' Meridian Health - Patient Portal (LEGACY)');
  console.log(' WARNING: This portal is DEPRECATED');
  console.log(' Running on port ' + PORT);
  console.log(' Environment: ' + (process.env.NODE_ENV || 'development'));
  console.log('==============================================');
});

module.exports = app;
