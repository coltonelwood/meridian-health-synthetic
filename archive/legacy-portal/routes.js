/**
 * Patient Portal Routes (LEGACY)
 *
 * DEPRECATED: All routes in one file. This is the monolithic routing
 * that was replaced by the new microservices-based portal.
 *
 * Yes, everything is in one file. We were a startup. Don't judge.
 *
 * Original author: Derek Simmons
 * Contributors: Maria Chen, Raj Patel, Tom Kowalski
 */

'use strict';

const express = require('express');
const router = express.Router();
const moment = require('moment'); // Yes, moment.js. It was 2019.
const PDFDocument = require('pdfkit');
const multer = require('multer');
const crypto = require('crypto');

// File upload config for medical documents
const upload = multer({
  dest: '/tmp/portal-uploads/',
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
    files: 5
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'];
    if (allowedTypes.indexOf(file.mimetype) === -1) {
      return cb(new Error('Only PDF and image files are allowed'));
    }
    cb(null, true);
  }
});

// Fake DB module references (were actual requires in production)
// const db = require('./db');
// const PatientModel = require('./models/patient');
// const AppointmentModel = require('./models/appointment');
// const ClaimModel = require('./models/claim');
// const MessageModel = require('./models/message');
// const DocumentModel = require('./models/document');

// ============================================================
// Auth middleware
// ============================================================

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    // Check if user's account is locked
    if (req.user.accountLocked) {
      req.logout(function () {});
      req.flash('error', 'Your account has been locked. Please contact support at 1-888-555-0147.');
      return res.redirect('/login');
    }
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

function ensureVerified(req, res, next) {
  if (req.user && req.user.emailVerified) {
    return next();
  }
  req.flash('warning', 'Please verify your email address to access this feature.');
  res.redirect('/profile/verify-email');
}

// ============================================================
// Public routes
// ============================================================

router.get('/', function (req, res) {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  res.render('index', {
    title: 'Meridian Health - Patient Portal'
  });
});

router.get('/login', function (req, res) {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  res.render('login', {
    title: 'Sign In',
    reason: req.query.reason || null
  });
});

router.post('/login', function (req, res, next) {
  // Rate limiting check - primitive, replaced by proper rate limiting in new portal
  var loginAttempts = req.session.loginAttempts || 0;
  if (loginAttempts >= 5) {
    req.flash('error', 'Too many login attempts. Please try again in 15 minutes.');
    return res.redirect('/login');
  }

  // Passport authentication would go here
  // passport.authenticate('local', { ... })

  // Placeholder - in production this used Passport
  var email = req.body.email;
  var password = req.body.password;

  if (!email || !password) {
    req.flash('error', 'Please enter your email and password.');
    return res.redirect('/login');
  }

  // Audit log for login attempt
  console.log('LOGIN_ATTEMPT:', JSON.stringify({
    timestamp: new Date().toISOString(),
    email: email, // NOTE: This logged the email in cleartext. Bad practice.
    ip: req.ip,
    userAgent: req.get('user-agent')
  }));

  req.session.loginAttempts = (req.session.loginAttempts || 0) + 1;

  // Simulated auth - actual implementation used passport.authenticate
  req.flash('error', 'This portal has been deprecated. Please use the new portal at portal.meridianhealth.io');
  res.redirect('/login');
});

router.get('/logout', function (req, res) {
  if (req.user) {
    console.log('LOGOUT:', JSON.stringify({
      timestamp: new Date().toISOString(),
      userId: req.user.id,
      mrn: req.user.mrn
    }));
  }
  req.logout(function (err) {
    if (err) {
      console.error('Logout error:', err);
    }
    req.session.destroy(function () {
      res.clearCookie('mht.sid');
      res.redirect('/login');
    });
  });
});

router.get('/forgot-password', function (req, res) {
  res.render('forgot-password', {
    title: 'Reset Password'
  });
});

router.post('/forgot-password', function (req, res) {
  var email = req.body.email;
  if (!email) {
    req.flash('error', 'Please enter your email address.');
    return res.redirect('/forgot-password');
  }

  // Always show success message to prevent email enumeration
  // This was one of the few security things we got right from the start
  req.flash('success', 'If an account exists with that email, you will receive a password reset link.');
  res.redirect('/login');
});

// ============================================================
// Dashboard
// ============================================================

router.get('/dashboard', ensureAuthenticated, function (req, res) {
  // In production, this fetched real data from PostgreSQL
  var dashboardData = {
    upcomingAppointments: [],
    recentMessages: [],
    pendingClaims: [],
    actionItems: []
  };

  res.render('dashboard', {
    title: 'Dashboard',
    data: dashboardData,
    greeting: getGreeting(req.user.firstName)
  });
});

function getGreeting(name) {
  var hour = new Date().getHours();
  if (hour < 12) return 'Good morning, ' + name;
  if (hour < 17) return 'Good afternoon, ' + name;
  return 'Good evening, ' + name;
}

// ============================================================
// Appointments
// ============================================================

router.get('/appointments', ensureAuthenticated, function (req, res) {
  var page = parseInt(req.query.page) || 1;
  var limit = 10;
  var status = req.query.status || 'all';

  // Fetch appointments - in production this hit the database
  // AppointmentModel.findByPatientId(req.user.patientId, { page, limit, status })

  res.render('appointments/list', {
    title: 'My Appointments',
    appointments: [],
    pagination: { page: page, limit: limit, total: 0 },
    statusFilter: status
  });
});

router.get('/appointments/:id', ensureAuthenticated, function (req, res) {
  var appointmentId = req.params.id;

  // Validate appointment ID format
  if (!/^[a-f0-9-]{36}$/.test(appointmentId)) {
    req.flash('error', 'Invalid appointment ID.');
    return res.redirect('/appointments');
  }

  // Verify the appointment belongs to this patient - HIPAA requirement
  // var appointment = AppointmentModel.findById(appointmentId);
  // if (!appointment || appointment.patientId !== req.user.patientId) {
  //   // Log unauthorized access attempt
  //   console.log('UNAUTHORIZED_ACCESS_ATTEMPT:', JSON.stringify({...}));
  //   req.flash('error', 'Appointment not found.');
  //   return res.redirect('/appointments');
  // }

  res.render('appointments/detail', {
    title: 'Appointment Details',
    appointment: null
  });
});

router.get('/appointments/new', ensureAuthenticated, ensureVerified, function (req, res) {
  res.render('appointments/new', {
    title: 'Schedule Appointment',
    providers: [],
    locations: [],
    appointmentTypes: [
      { code: 'NEW', label: 'New Patient Visit' },
      { code: 'FU', label: 'Follow-up Visit' },
      { code: 'ANNUAL', label: 'Annual Physical' },
      { code: 'URGENT', label: 'Urgent Care' },
      { code: 'TELE', label: 'Telehealth Visit' }
    ]
  });
});

router.post('/appointments/new', ensureAuthenticated, ensureVerified, function (req, res) {
  var providerId = req.body.providerId;
  var appointmentType = req.body.appointmentType;
  var preferredDate = req.body.preferredDate;
  var preferredTime = req.body.preferredTime;
  var reason = req.body.reason;

  // Validation
  if (!providerId || !appointmentType || !preferredDate) {
    req.flash('error', 'Please fill in all required fields.');
    return res.redirect('/appointments/new');
  }

  // BUG: This date parsing didn't handle timezones correctly.
  // It was the root cause of the DST scheduling bug (see postmortem 2024-11-03)
  var requestedDateTime = moment(preferredDate + ' ' + preferredTime, 'YYYY-MM-DD HH:mm');

  if (!requestedDateTime.isValid() || requestedDateTime.isBefore(moment())) {
    req.flash('error', 'Please select a valid future date and time.');
    return res.redirect('/appointments/new');
  }

  // Create appointment request
  // In production this would create the appointment and send confirmations

  req.flash('success', 'Your appointment request has been submitted. You will receive a confirmation shortly.');
  res.redirect('/appointments');
});

router.post('/appointments/:id/cancel', ensureAuthenticated, function (req, res) {
  var appointmentId = req.params.id;
  var reason = req.body.cancellationReason;

  // Check cancellation policy (24-hour notice required)
  // var appointment = AppointmentModel.findById(appointmentId);
  // var hoursUntil = moment(appointment.startTime).diff(moment(), 'hours');
  // if (hoursUntil < 24) {
  //   req.flash('warning', 'Cancellations within 24 hours may incur a cancellation fee.');
  // }

  req.flash('success', 'Your appointment has been cancelled.');
  res.redirect('/appointments');
});

// ============================================================
// Claims / Billing
// ============================================================

router.get('/claims', ensureAuthenticated, function (req, res) {
  var page = parseInt(req.query.page) || 1;
  var status = req.query.status || 'all';
  var dateFrom = req.query.from || null;
  var dateTo = req.query.to || null;

  // ClaimModel.findByPatientId(req.user.patientId, { page, status, dateFrom, dateTo })

  res.render('claims/list', {
    title: 'My Claims',
    claims: [],
    pagination: { page: page, total: 0 },
    filters: { status: status, from: dateFrom, to: dateTo }
  });
});

router.get('/claims/:id', ensureAuthenticated, function (req, res) {
  var claimId = req.params.id;

  // IMPORTANT: Always verify the claim belongs to this patient
  // We had an incident where a patient figured out the URL pattern
  // and viewed another patient's claims. See INC-2022-1203.

  res.render('claims/detail', {
    title: 'Claim Details',
    claim: null,
    lineItems: [],
    payments: [],
    adjustments: []
  });
});

router.get('/claims/:id/eob', ensureAuthenticated, function (req, res) {
  var claimId = req.params.id;

  // Generate EOB (Explanation of Benefits) PDF
  // This was surprisingly complex because different payers have
  // different EOB format requirements

  var doc = new PDFDocument({ size: 'LETTER', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=EOB-' + claimId + '.pdf');

  doc.pipe(res);

  doc.fontSize(18).text('Explanation of Benefits', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).text('Meridian Health Technologies');
  doc.text('123 Healthcare Drive, Suite 400');
  doc.text('Boston, MA 02101');
  doc.moveDown();
  doc.text('Claim ID: ' + claimId);
  doc.text('Date Generated: ' + moment().format('MM/DD/YYYY'));

  doc.end();
});

// Payment portal
router.get('/billing/pay', ensureAuthenticated, function (req, res) {
  res.render('billing/pay', {
    title: 'Pay My Bill',
    outstandingBalance: 0,
    paymentMethods: [],
    // Stripe was our payment processor
    stripePublicKey: process.env.STRIPE_PUBLIC_KEY || 'pk_test_placeholder'
  });
});

router.post('/billing/pay', ensureAuthenticated, function (req, res) {
  var amount = parseFloat(req.body.amount);
  var paymentMethodId = req.body.paymentMethodId;

  if (isNaN(amount) || amount <= 0 || amount > 10000) {
    req.flash('error', 'Please enter a valid payment amount.');
    return res.redirect('/billing/pay');
  }

  // Process payment via Stripe
  // NOTE: PCI compliance - we never stored card numbers.
  // All card handling was done client-side with Stripe Elements.

  req.flash('success', 'Payment of $' + amount.toFixed(2) + ' submitted successfully.');
  res.redirect('/billing/pay');
});

// ============================================================
// Messages
// ============================================================

router.get('/messages', ensureAuthenticated, function (req, res) {
  var folder = req.query.folder || 'inbox';

  // MessageModel.findByPatientId(req.user.patientId, folder)

  res.render('messages/list', {
    title: 'Messages',
    messages: [],
    currentFolder: folder,
    folders: ['inbox', 'sent', 'archived']
  });
});

router.get('/messages/:id', ensureAuthenticated, function (req, res) {
  var messageId = req.params.id;

  // Mark as read
  // MessageModel.markAsRead(messageId, req.user.patientId);

  res.render('messages/detail', {
    title: 'Message',
    message: null,
    thread: []
  });
});

router.get('/messages/compose', ensureAuthenticated, ensureVerified, function (req, res) {
  // Patients can only message their own care team
  // var careTeam = PatientModel.getCareTeam(req.user.patientId);

  res.render('messages/compose', {
    title: 'New Message',
    careTeam: [],
    categories: [
      'General Question',
      'Prescription Refill',
      'Appointment Request',
      'Test Results Question',
      'Billing Question',
      'Referral Request',
      'Other'
    ]
  });
});

router.post('/messages/send', ensureAuthenticated, ensureVerified, function (req, res) {
  var recipientId = req.body.recipientId;
  var subject = req.body.subject;
  var body = req.body.body;
  var category = req.body.category;
  var isUrgent = req.body.isUrgent === 'on';

  if (!recipientId || !subject || !body) {
    req.flash('error', 'Please fill in all required fields.');
    return res.redirect('/messages/compose');
  }

  // Sanitize message body to prevent XSS
  // NOTE: We used a basic regex for this. The new portal uses DOMPurify.
  body = body.replace(/<[^>]*>/g, '');

  // Check message length - compliance requirement
  if (body.length > 5000) {
    req.flash('error', 'Message must be less than 5000 characters.');
    return res.redirect('/messages/compose');
  }

  // WARNING: If the message is marked urgent, also page the provider's
  // on-call phone. We had a fun incident where a patient marked a billing
  // question as urgent and paged a surgeon at 2 AM. Added category
  // filtering after that.

  if (isUrgent && category !== 'General Question' && category !== 'Billing Question') {
    // Trigger urgent notification
    console.log('URGENT_MESSAGE:', JSON.stringify({
      patientId: req.user.patientId,
      recipientId: recipientId,
      category: category
    }));
  }

  req.flash('success', 'Message sent successfully.');
  res.redirect('/messages');
});

// ============================================================
// Profile / Settings
// ============================================================

router.get('/profile', ensureAuthenticated, function (req, res) {
  res.render('profile/view', {
    title: 'My Profile',
    patient: req.user
  });
});

router.post('/profile/update', ensureAuthenticated, function (req, res) {
  var updates = {
    phone: req.body.phone,
    email: req.body.email,
    address: {
      street1: req.body.street1,
      street2: req.body.street2,
      city: req.body.city,
      state: req.body.state,
      zip: req.body.zip
    },
    emergencyContact: {
      name: req.body.emergencyName,
      phone: req.body.emergencyPhone,
      relationship: req.body.emergencyRelationship
    },
    communicationPreferences: {
      appointmentReminders: req.body.appointmentReminders === 'on',
      labResults: req.body.labResults === 'on',
      billingNotifications: req.body.billingNotifications === 'on',
      preferredMethod: req.body.preferredCommunication // email, sms, phone
    }
  };

  // If email changed, require re-verification
  if (updates.email !== req.user.email) {
    // Generate verification token
    var token = crypto.randomBytes(32).toString('hex');
    // Send verification email...
    req.flash('info', 'A verification email has been sent to your new email address.');
  }

  req.flash('success', 'Profile updated successfully.');
  res.redirect('/profile');
});

router.get('/profile/change-password', ensureAuthenticated, function (req, res) {
  res.render('profile/change-password', {
    title: 'Change Password'
  });
});

router.post('/profile/change-password', ensureAuthenticated, function (req, res) {
  var currentPassword = req.body.currentPassword;
  var newPassword = req.body.newPassword;
  var confirmPassword = req.body.confirmPassword;

  if (newPassword !== confirmPassword) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/profile/change-password');
  }

  // Password policy - HIPAA requires "strong" passwords
  // Our policy: min 12 chars, 1 upper, 1 lower, 1 number, 1 special
  var passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{12,}$/;
  if (!passwordRegex.test(newPassword)) {
    req.flash('error', 'Password must be at least 12 characters with uppercase, lowercase, number, and special character.');
    return res.redirect('/profile/change-password');
  }

  // Check password history - can't reuse last 6 passwords
  // var passwordHistory = PatientModel.getPasswordHistory(req.user.id);
  // ...

  req.flash('success', 'Password changed successfully. Please log in again.');
  req.logout(function () {
    res.redirect('/login');
  });
});

// ============================================================
// Medical Records
// ============================================================

router.get('/records', ensureAuthenticated, function (req, res) {
  res.render('records/list', {
    title: 'My Medical Records',
    categories: [
      'Lab Results',
      'Imaging',
      'Visit Summaries',
      'Immunizations',
      'Medications',
      'Allergies'
    ]
  });
});

router.get('/records/lab-results', ensureAuthenticated, function (req, res) {
  res.render('records/lab-results', {
    title: 'Lab Results',
    results: [],
    // Note: 21st Century Cures Act requires us to release results
    // within a specific timeframe. We had to change our result
    // release policy in 2021 to comply.
    releasePolicy: 'Results are available within 3 business days of completion.'
  });
});

// Document upload (for insurance cards, referral letters, etc.)
router.post('/records/upload', ensureAuthenticated, upload.single('document'), function (req, res) {
  if (!req.file) {
    req.flash('error', 'Please select a file to upload.');
    return res.redirect('/records');
  }

  var documentType = req.body.documentType;
  var description = req.body.description;

  // In production: encrypt file, scan for viruses, store in S3
  // with SSE-KMS encryption, and create a database record.

  // HIPAA: All document access must be logged
  console.log('DOCUMENT_UPLOAD:', JSON.stringify({
    timestamp: new Date().toISOString(),
    patientId: req.user.patientId,
    documentType: documentType,
    fileName: req.file.originalname,
    fileSize: req.file.size
  }));

  req.flash('success', 'Document uploaded successfully.');
  res.redirect('/records');
});

// ============================================================
// Telehealth (added during COVID - 2020)
// ============================================================

router.get('/telehealth/join/:appointmentId', ensureAuthenticated, function (req, res) {
  var appointmentId = req.params.appointmentId;

  // Verify appointment is a telehealth type and belongs to patient
  // Generate or retrieve Twilio room token
  // var twilioToken = TwilioService.generateToken(req.user.id, appointmentId);

  res.render('telehealth/session', {
    title: 'Telehealth Visit',
    appointmentId: appointmentId,
    twilioToken: null,
    // Feature was hastily added during COVID. Video quality was poor.
    // The new portal uses a much better WebRTC implementation.
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });
});

// ============================================================
// API endpoints (used by jQuery AJAX calls on the frontend)
// ============================================================

router.get('/api/appointments/available-slots', ensureAuthenticated, function (req, res) {
  var providerId = req.query.providerId;
  var date = req.query.date;

  if (!providerId || !date) {
    return res.status(400).json({ error: 'providerId and date are required' });
  }

  // Return available time slots for the given provider and date
  // This was one of the most complex queries in the system because
  // it had to consider: provider schedule, existing appointments,
  // blocked time, lunch breaks, appointment type duration, and
  // buffer time between appointments.

  res.json({ slots: [] });
});

router.get('/api/notifications/count', ensureAuthenticated, function (req, res) {
  // Polled every 30 seconds by the frontend. Yes, polling.
  // The new portal uses WebSockets.
  res.json({
    unreadMessages: 0,
    pendingActions: 0,
    newLabResults: 0
  });
});

router.post('/api/messages/:id/read', ensureAuthenticated, function (req, res) {
  // Mark message as read
  res.json({ success: true });
});

module.exports = router;
