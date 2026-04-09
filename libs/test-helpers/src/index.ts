/**
 * @meridian/test-helpers
 *
 * Shared test utilities for all Meridian Health services.
 * Provides factories for creating test data, database setup/teardown,
 * and common mock objects.
 *
 * Usage:
 * ```
 * import { createPatient, createClaim, setupTestDb } from '@meridian/test-helpers';
 *
 * describe('MyService', () => {
 *   const db = setupTestDb();
 *
 *   it('should process a claim', async () => {
 *     const patient = createPatient({ firstName: 'Test' });
 *     const claim = createClaim({ patientId: patient.id });
 *     // ...
 *   });
 * });
 * ```
 */

export {
  createPatient,
  createClaim,
  createProvider,
  createAppointment,
  createReferral,
  createInsurance,
  createServiceLine,
  createDiagnosis,
  createMedication,
} from './factories';

export {
  setupTestDb,
  teardownTestDb,
  cleanTestData,
  TestDatabase,
} from './dbSetup';

export {
  mockPatientService,
  mockClaimService,
  mockNotificationService,
  mockSchedulingService,
  mockEligibilityClient,
  mockClearinghouseClient,
  mockEventBus,
  mockHIPAALogger,
} from './mocks';
