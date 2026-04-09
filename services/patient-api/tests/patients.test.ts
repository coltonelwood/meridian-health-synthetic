import request from 'supertest';
import express from 'express';
// import app from '../src/index'; // can't import directly because of DB connection

// Mock the TypeORM getRepository
jest.mock('typeorm', () => ({
  getRepository: jest.fn(),
  createConnection: jest.fn(),
  PrimaryGeneratedColumn: () => () => {},
  Column: () => () => {},
  Entity: () => () => {},
  CreateDateColumn: () => () => {},
  UpdateDateColumn: () => () => {},
  OneToMany: () => () => {},
  ManyToOne: () => () => {},
  JoinColumn: () => () => {},
  Index: () => () => {},
  BeforeInsert: () => () => {},
}));

// Mock auth middleware
jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.user = {
      userId: 'test-user-123',
      email: 'testuser@meridianhealth.com',
      roles: ['provider'],
      organizationId: 'org-001',
      permissions: ['patient:read', 'patient:write'],
    };
    next();
  },
}));

// Mock HIPAA audit middleware
jest.mock('../src/middleware/hipaa-audit', () => ({
  hipaaAuditMiddleware: (req: any, res: any, next: any) => next(),
}));

// Mock the patient service
jest.mock('../src/services/patientService');

import { PatientService } from '../src/services/patientService';
import patientRoutes from '../src/routes/patients';

const MockPatientService = PatientService as jest.MockedClass<typeof PatientService>;

// Build a test app
const app = express();
app.use(express.json());
app.use((req: any, res, next) => {
  req.user = {
    userId: 'test-user-123',
    email: 'testuser@meridianhealth.com',
    roles: ['provider'],
    organizationId: 'org-001',
    permissions: ['patient:read', 'patient:write'],
  };
  next();
});
app.use('/api/v1/patients', patientRoutes);

// Sample test data
const samplePatient = {
  id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  mrn: 'MRN-12345678',
  firstName: 'Jane',
  middleName: 'Marie',
  lastName: 'Doe',
  dateOfBirth: '1985-03-15',
  gender: 'female',
  preferredLanguage: 'en',
  status: 'active',
  isActive: true,
  email: 'jane.doe@example.com',
  mobilePhone: '555-123-4567',
  createdAt: new Date('2024-01-15'),
  updatedAt: new Date('2024-06-20'),
  addresses: [],
  insuranceCoverages: [],
};

const samplePatient2 = {
  id: 'a1b2c3d4-e5f6-4321-abcd-0e02b2c3d480',
  mrn: 'MRN-87654321',
  firstName: 'John',
  lastName: 'Smith',
  dateOfBirth: '1972-11-08',
  gender: 'male',
  preferredLanguage: 'en',
  status: 'active',
  isActive: true,
  createdAt: new Date('2024-02-10'),
  updatedAt: new Date('2024-05-15'),
  addresses: [],
  insuranceCoverages: [],
};

describe('Patient Routes', () => {
  let mockGetPatientById: jest.Mock;
  let mockGetPatientByMRN: jest.Mock;
  let mockCreatePatient: jest.Mock;
  let mockUpdatePatient: jest.Mock;
  let mockDeactivatePatient: jest.Mock;
  let mockFindPotentialDuplicates: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetPatientById = jest.fn();
    mockGetPatientByMRN = jest.fn();
    mockCreatePatient = jest.fn();
    mockUpdatePatient = jest.fn();
    mockDeactivatePatient = jest.fn();
    mockFindPotentialDuplicates = jest.fn();

    MockPatientService.prototype.getPatientById = mockGetPatientById;
    MockPatientService.prototype.getPatientByMRN = mockGetPatientByMRN;
    MockPatientService.prototype.createPatient = mockCreatePatient;
    MockPatientService.prototype.updatePatient = mockUpdatePatient;
    MockPatientService.prototype.deactivatePatient = mockDeactivatePatient;
    MockPatientService.prototype.findPotentialDuplicates = mockFindPotentialDuplicates;
  });

  describe('GET /api/v1/patients/:id', () => {
    it('should return a patient by ID', async () => {
      mockGetPatientById.mockResolvedValue(samplePatient);

      const res = await request(app)
        .get(`/api/v1/patients/${samplePatient.id}`)
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBe(samplePatient.id);
      expect(res.body.data.firstName).toBe('Jane');
      expect(mockGetPatientById).toHaveBeenCalledWith(samplePatient.id);
    });

    it('should return 404 for non-existent patient', async () => {
      mockGetPatientById.mockResolvedValue(undefined);

      const res = await request(app)
        .get('/api/v1/patients/non-existent-id')
        .expect(404);

      expect(res.body.error).toBe('Not Found');
    });

    it('should return 400 for invalid UUID format', async () => {
      mockGetPatientById.mockRejectedValue(
        new Error('invalid input syntax for type uuid')
      );

      const res = await request(app)
        .get('/api/v1/patients/not-a-uuid')
        .expect(400);

      expect(res.body.error).toBe('Bad Request');
    });

    // TODO: test FHIR format response
    xit('should return FHIR Patient resource when Accept header is application/fhir+json', async () => {
      mockGetPatientById.mockResolvedValue(samplePatient);

      const res = await request(app)
        .get(`/api/v1/patients/${samplePatient.id}`)
        .set('Accept', 'application/fhir+json')
        .expect(200);

      expect(res.body.resourceType).toBe('Patient');
      expect(res.body.id).toBe(samplePatient.id);
    });
  });

  describe('GET /api/v1/patients/mrn/:mrn', () => {
    it('should return a patient by MRN', async () => {
      mockGetPatientByMRN.mockResolvedValue(samplePatient);

      const res = await request(app)
        .get('/api/v1/patients/mrn/MRN-12345678')
        .expect(200);

      expect(res.body.data.mrn).toBe('MRN-12345678');
    });

    it('should return 400 for invalid MRN format', async () => {
      const res = await request(app)
        .get('/api/v1/patients/mrn/INVALID')
        .expect(400);

      expect(res.body.error).toBe('Invalid MRN format');
    });

    it('should return 404 for non-existent MRN', async () => {
      mockGetPatientByMRN.mockResolvedValue(undefined);

      const res = await request(app)
        .get('/api/v1/patients/mrn/MRN-99999999')
        .expect(404);

      expect(res.body.error).toBe('Not Found');
    });
  });

  describe('POST /api/v1/patients', () => {
    const validPatientData = {
      firstName: 'Alice',
      lastName: 'Johnson',
      dateOfBirth: '1990-05-20',
      gender: 'female',
      email: 'alice@example.com',
    };

    it('should create a new patient', async () => {
      mockFindPotentialDuplicates.mockResolvedValue([]);
      mockCreatePatient.mockResolvedValue({
        id: 'new-patient-id',
        mrn: 'MRN-11111111',
        ...validPatientData,
      });

      const res = await request(app)
        .post('/api/v1/patients')
        .send(validPatientData)
        .expect(201);

      expect(res.body.data.id).toBe('new-patient-id');
      expect(res.body.message).toBe('Patient created successfully');
    });

    it('should return 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/v1/patients')
        .send({ firstName: 'Alice' }) // missing lastName, dob, gender
        .expect(400);

      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details.length).toBeGreaterThan(0);
    });

    it('should return 400 for invalid date of birth', async () => {
      const res = await request(app)
        .post('/api/v1/patients')
        .send({
          ...validPatientData,
          dateOfBirth: '2030-01-01', // future date
        })
        .expect(400);

      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'dateOfBirth' }),
        ])
      );
    });

    it('should detect duplicate MRN', async () => {
      mockGetPatientByMRN = jest.fn().mockResolvedValue(samplePatient);
      MockPatientService.prototype.getPatientByMRN = mockGetPatientByMRN;

      const res = await request(app)
        .post('/api/v1/patients')
        .send({
          ...validPatientData,
          mrn: 'MRN-12345678',
        })
        .expect(409);

      expect(res.body.error).toBe('Conflict');
    });

    it('should warn about potential duplicates', async () => {
      mockFindPotentialDuplicates.mockResolvedValue([samplePatient]);
      // Make sure getPatientByMRN returns null (no MRN conflict)
      mockGetPatientByMRN.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/v1/patients')
        .send(validPatientData)
        .expect(409);

      expect(res.body.error).toBe('Potential Duplicate');
      expect(res.body.potentialMatches).toHaveLength(1);
    });

    it('should allow creation when confirmNotDuplicate is set', async () => {
      mockFindPotentialDuplicates.mockResolvedValue([samplePatient]);
      mockCreatePatient.mockResolvedValue({
        id: 'new-id',
        ...validPatientData,
      });

      const res = await request(app)
        .post('/api/v1/patients')
        .send({
          ...validPatientData,
          confirmNotDuplicate: true,
        })
        .expect(201);

      expect(res.body.data.id).toBe('new-id');
    });

    // TODO: test batch creation
    xit('should handle batch patient creation', async () => {
      // need to set up the mock differently for batch
    });
  });

  describe('PUT /api/v1/patients/:id', () => {
    it('should update a patient', async () => {
      mockGetPatientById.mockResolvedValue(samplePatient);
      mockUpdatePatient.mockResolvedValue({
        ...samplePatient,
        lastName: 'Smith-Doe',
      });

      const res = await request(app)
        .put(`/api/v1/patients/${samplePatient.id}`)
        .send({ lastName: 'Smith-Doe' })
        .expect(200);

      expect(res.body.data.lastName).toBe('Smith-Doe');
    });

    it('should return 404 for non-existent patient', async () => {
      mockGetPatientById.mockResolvedValue(undefined);

      const res = await request(app)
        .put('/api/v1/patients/non-existent-id')
        .send({ lastName: 'Test' })
        .expect(404);
    });
  });

  describe('DELETE /api/v1/patients/:id', () => {
    it('should soft-delete (deactivate) a patient', async () => {
      mockGetPatientById.mockResolvedValue(samplePatient);
      mockDeactivatePatient.mockResolvedValue(undefined);

      const res = await request(app)
        .delete(`/api/v1/patients/${samplePatient.id}`)
        .expect(200);

      expect(res.body.message).toBe('Patient deactivated successfully');
      expect(mockDeactivatePatient).toHaveBeenCalledWith(
        samplePatient.id,
        expect.any(Object) // user object
      );
    });

    it('should return 404 for non-existent patient', async () => {
      mockGetPatientById.mockResolvedValue(undefined);

      await request(app)
        .delete('/api/v1/patients/non-existent-id')
        .expect(404);
    });
  });

  describe('POST /api/v1/patients/:id/merge', () => {
    it('should return 501 (not implemented)', async () => {
      const res = await request(app)
        .post(`/api/v1/patients/${samplePatient.id}/merge`)
        .send({ targetPatientId: samplePatient2.id })
        .expect(501);

      expect(res.body.error).toBe('Not Implemented');
    });
  });

  // These tests are skipped because the batch endpoint needs different mocking
  xdescribe('POST /api/v1/patients/batch', () => {
    it('should reject empty batch', async () => {
      const res = await request(app)
        .post('/api/v1/patients/batch')
        .send({ patients: [] })
        .expect(400);
    });

    it('should reject batch over 500', async () => {
      const patients = Array(501).fill({
        firstName: 'Test',
        lastName: 'Patient',
        dateOfBirth: '2000-01-01',
        gender: 'unknown',
      });

      const res = await request(app)
        .post('/api/v1/patients/batch')
        .send({ patients })
        .expect(400);
    });

    it('should process valid batch', async () => {
      // TODO: implement this test
    });
  });
});

// GET /api/v1/patients (list) tests are more complex because they use
// the TypeORM query builder directly instead of going through the service.
// We'd need to mock the query builder chain which is painful.
// TODO: refactor the list endpoint to use the service layer (PLAT-3892)

xdescribe('GET /api/v1/patients (list)', () => {
  it('should return paginated patient list', async () => {
    // TODO
  });

  it('should filter by search term', async () => {
    // TODO
  });

  it('should filter by status', async () => {
    // TODO
  });

  it('should cap limit at 100', async () => {
    // TODO
  });

  it('should return FHIR Bundle when requested', async () => {
    // TODO
  });
});
