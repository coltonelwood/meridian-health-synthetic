/**
 * Common mock objects for Meridian Health services.
 *
 * These mocks provide sensible default behaviors that can be
 * overridden in individual tests. Use jest.fn() for methods
 * that need to be spied on.
 */

import { createPatient, createClaim, createProvider, createAppointment } from './factories';

// --- Patient Service Mock ----------------------------------------------------

export function mockPatientService() {
  return {
    getPatient: jest.fn().mockResolvedValue(createPatient()),
    createPatient: jest.fn().mockImplementation((data: any) =>
      Promise.resolve({ ...createPatient(), ...data, id: `pat-${Date.now()}` })
    ),
    updatePatient: jest.fn().mockResolvedValue(undefined),
    findDuplicates: jest.fn().mockResolvedValue([]),
    getBalance: jest.fn().mockResolvedValue(0),
    addToBalance: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
}

// --- Claim Service Mock ------------------------------------------------------

export function mockClaimService() {
  return {
    getClaim: jest.fn().mockResolvedValue(createClaim()),
    createClaim: jest.fn().mockImplementation((data: any) =>
      Promise.resolve({ ...createClaim(), ...data, id: `clm-${Date.now()}` })
    ),
    updateClaim: jest.fn().mockResolvedValue(undefined),
    findByTrackingNumber: jest.fn().mockResolvedValue(null),
    findByPatientAndDate: jest.fn().mockResolvedValue([]),
    findBySubscriberAndProcedure: jest.fn().mockResolvedValue([]),
  };
}

// --- Notification Service Mock -----------------------------------------------

export function mockNotificationService() {
  const sentNotifications: any[] = [];

  return {
    send: jest.fn().mockImplementation((notification: any) => {
      sentNotifications.push(notification);
      return Promise.resolve({ id: `notif-${Date.now()}`, status: 'sent' });
    }),
    scheduleCall: jest.fn().mockResolvedValue({ id: `call-${Date.now()}` }),
    getSentNotifications: () => sentNotifications,
    clearSentNotifications: () => { sentNotifications.length = 0; },
  };
}

// --- Scheduling Service Mock -------------------------------------------------

export function mockSchedulingService() {
  return {
    findAvailableSlots: jest.fn().mockResolvedValue([
      {
        id: `slot-${Date.now()}`,
        dateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        duration: 30,
        providerId: 'provider-mock-1',
        providerName: 'Dr. Mock Provider',
      },
    ]),
    bookAppointment: jest.fn().mockImplementation((data: any) =>
      Promise.resolve({
        ...createAppointment(),
        ...data,
        id: `apt-${Date.now()}`,
        status: 'scheduled',
      })
    ),
    cancelAppointment: jest.fn().mockResolvedValue(undefined),
    addToWaitlist: jest.fn().mockResolvedValue({ id: `wl-${Date.now()}` }),
    getAppointments: jest.fn().mockResolvedValue([]),
  };
}

// --- Eligibility Client Mock -------------------------------------------------

export function mockEligibilityClient() {
  return {
    checkEligibility: jest.fn().mockResolvedValue({
      eligible: true,
      planName: 'Mock PPO Plan',
      groupNumber: 'GRP-MOCK',
      copayAmount: 3000, // $30
      deductibleRemaining: 100000, // $1,000
      priorAuthRequired: false,
      effectiveDate: '2026-01-01',
      terminationDate: null,
      warnings: [],
    }),
    checkAuthRequirement: jest.fn().mockResolvedValue({
      required: false,
    }),
    requestAuthorization: jest.fn().mockResolvedValue({
      authorizationNumber: `AUTH-${Date.now()}`,
      status: 'approved',
    }),
  };
}

// --- Clearinghouse Client Mock -----------------------------------------------

export function mockClearinghouseClient() {
  return {
    submitClaim: jest.fn().mockResolvedValue({
      accepted: true,
      trackingNumber: `TRK-${Date.now()}`,
      responseCode: '200',
    }),
    checkStatus: jest.fn().mockResolvedValue({
      status: 'accepted',
      lastUpdated: new Date().toISOString(),
    }),
    submitAppeal: jest.fn().mockResolvedValue({
      trackingNumber: `APL-${Date.now()}`,
      submitted: true,
    }),
  };
}

// --- Event Bus Mock ----------------------------------------------------------

export function mockEventBus() {
  const publishedEvents: Array<{ type: string; payload: any }> = [];
  const subscribers: Map<string, Function[]> = new Map();

  return {
    publish: jest.fn().mockImplementation((type: string, payload: any) => {
      publishedEvents.push({ type, payload });

      // Optionally trigger subscribers for in-process testing
      const handlers = subscribers.get(type) || [];
      handlers.forEach(h => h(payload, {
        eventId: `evt-mock-${Date.now()}`,
        eventType: type,
        timestamp: new Date().toISOString(),
        source: 'test',
        correlationId: 'test-correlation',
      }));

      return Promise.resolve();
    }),
    subscribe: jest.fn().mockImplementation((type: string, handler: Function) => {
      const handlers = subscribers.get(type) || [];
      handlers.push(handler);
      subscribers.set(type, handlers);
      return Promise.resolve();
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    getPublishedEvents: () => publishedEvents,
    clearPublishedEvents: () => { publishedEvents.length = 0; },
    getPublishedEventsOfType: (type: string) =>
      publishedEvents.filter(e => e.type === type),
  };
}

// --- HIPAA Logger Mock -------------------------------------------------------

export function mockHIPAALogger() {
  const logEntries: any[] = [];

  return {
    info: jest.fn().mockImplementation((msg: string, meta?: any) => {
      logEntries.push({ level: 'info', message: msg, ...meta });
    }),
    warn: jest.fn().mockImplementation((msg: string, meta?: any) => {
      logEntries.push({ level: 'warn', message: msg, ...meta });
    }),
    error: jest.fn().mockImplementation((msg: string, meta?: any) => {
      logEntries.push({ level: 'error', message: msg, ...meta });
    }),
    debug: jest.fn().mockImplementation((msg: string, meta?: any) => {
      logEntries.push({ level: 'debug', message: msg, ...meta });
    }),
    audit: jest.fn().mockImplementation((msg: string, entry: any) => {
      logEntries.push({ level: 'audit', message: msg, ...entry });
    }),
    phiAccess: jest.fn().mockImplementation((entry: any) => {
      logEntries.push({ level: 'audit', type: 'phi_access', ...entry });
    }),
    child: jest.fn().mockReturnThis(),
    getLogEntries: () => logEntries,
    getAuditEntries: () => logEntries.filter(e => e.level === 'audit'),
    clearLogEntries: () => { logEntries.length = 0; },
  };
}
