import nock from 'nock';
import { FHIRClient } from '../src/index';
import { FHIRPatient, FHIRBundle } from '../src/types';

const BASE_URL = 'https://fhir.example.com/r4';

describe('FHIRClient', () => {
  let client: FHIRClient;

  beforeEach(() => {
    client = new FHIRClient({
      baseUrl: BASE_URL,
      auth: { type: 'bearer', token: 'test-token' },
      retries: 0, // disable retries in tests
    });
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('read', () => {
    it('should read a Patient resource by ID', async () => {
      const mockPatient: FHIRPatient = {
        resourceType: 'Patient',
        id: 'patient-123',
        name: [{ family: 'Smith', given: ['John'] }],
        birthDate: '1990-01-15',
        gender: 'male',
      };

      nock(BASE_URL)
        .get('/Patient/patient-123')
        .reply(200, mockPatient);

      const result = await client.read<FHIRPatient>('Patient', 'patient-123');

      expect(result.resourceType).toBe('Patient');
      expect(result.id).toBe('patient-123');
      expect(result.name![0].family).toBe('Smith');
    });

    it('should throw on 404', async () => {
      nock(BASE_URL)
        .get('/Patient/not-found')
        .reply(404, {
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'not-found', diagnostics: 'Patient not found' }],
        });

      await expect(client.read('Patient', 'not-found')).rejects.toThrow();
    });
  });

  describe('create', () => {
    it('should create a Patient resource', async () => {
      const newPatient: FHIRPatient = {
        resourceType: 'Patient',
        name: [{ family: 'Doe', given: ['Jane'] }],
        birthDate: '1985-06-20',
        gender: 'female',
      };

      const createdPatient = { ...newPatient, id: 'patient-new' };

      nock(BASE_URL)
        .post('/Patient', (body: any) => body.resourceType === 'Patient')
        .reply(201, createdPatient);

      const result = await client.create('Patient', newPatient);

      expect(result.id).toBe('patient-new');
    });
  });

  describe('search', () => {
    it('should search for patients by name', async () => {
      const bundle: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 1,
        entry: [
          {
            resource: {
              resourceType: 'Patient',
              id: 'p-1',
              name: [{ family: 'Smith' }],
            },
          },
        ],
      };

      nock(BASE_URL)
        .get('/Patient')
        .query({ name: 'Smith' })
        .reply(200, bundle);

      const result = await client.search<FHIRPatient>('Patient', { name: 'Smith' });

      expect(result.total).toBe(1);
      expect(result.entry![0].resource.id).toBe('p-1');
    });

    it('should handle empty search results', async () => {
      const bundle: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 0,
      };

      nock(BASE_URL)
        .get('/Patient')
        .query({ name: 'NonExistent' })
        .reply(200, bundle);

      const result = await client.search<FHIRPatient>('Patient', { name: 'NonExistent' });

      expect(result.total).toBe(0);
      expect(result.entry).toBeUndefined();
    });
  });

  describe('search builder', () => {
    it('should build and execute search queries', async () => {
      const bundle: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 1,
        entry: [
          {
            resource: {
              resourceType: 'Patient',
              id: 'p-1',
              name: [{ family: 'Smith' }],
            },
          },
        ],
      };

      nock(BASE_URL)
        .get('/Patient')
        .query({
          name: 'Smith',
          birthdate: 'gt1990-01-01',
          _count: '10',
          _sort: 'name',
        })
        .reply(200, bundle);

      const result = await client.searchBuilder('Patient')
        .where('name', 'Smith')
        .where('birthdate', 'gt1990-01-01')
        .count(10)
        .sort('name')
        .execute<FHIRPatient>();

      expect(result.total).toBe(1);
    });

    it('should build params without executing', () => {
      const params = client.searchBuilder('Patient')
        .where('name', 'Smith')
        .whereToken('identifier', 'http://meridianhealth.io/mrn', 'MH-ABC123')
        .count(20)
        .build();

      expect(params.name).toBe('Smith');
      expect(params.identifier).toBe('http://meridianhealth.io/mrn|MH-ABC123');
      expect(params._count).toBe('20');
    });
  });

  describe('getPatientByMRN', () => {
    it('should find a patient by MRN', async () => {
      const bundle: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 1,
        entry: [
          {
            resource: {
              resourceType: 'Patient',
              id: 'p-1',
              identifier: [{
                system: 'http://meridianhealth.io/fhir/mrn',
                value: 'MH-ABCDEFGHIJ',
              }],
            },
          },
        ],
      };

      nock(BASE_URL)
        .get('/Patient')
        .query({ identifier: 'http://meridianhealth.io/fhir/mrn|MH-ABCDEFGHIJ' })
        .reply(200, bundle);

      const result = await client.getPatientByMRN('MH-ABCDEFGHIJ');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('p-1');
    });

    it('should return null when MRN not found', async () => {
      const bundle: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 0,
      };

      nock(BASE_URL)
        .get('/Patient')
        .query({ identifier: 'http://meridianhealth.io/fhir/mrn|MH-NOTFOUND00' })
        .reply(200, bundle);

      const result = await client.getPatientByMRN('MH-NOTFOUND00');
      expect(result).toBeNull();
    });
  });

  describe('auth', () => {
    it('should send Bearer token in requests', async () => {
      nock(BASE_URL, {
        reqheaders: {
          authorization: 'Bearer test-token',
        },
      })
        .get('/Patient/p-1')
        .reply(200, { resourceType: 'Patient', id: 'p-1' });

      const result = await client.read('Patient', 'p-1');
      expect(result.id).toBe('p-1');
    });
  });

  describe('pagination', () => {
    it('should follow next page links', async () => {
      const page1: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 2,
        link: [
          { relation: 'next', url: `${BASE_URL}/Patient?_page=2` },
        ],
        entry: [
          { resource: { resourceType: 'Patient', id: 'p-1' } },
        ],
      };

      const page2: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 2,
        entry: [
          { resource: { resourceType: 'Patient', id: 'p-2' } },
        ],
      };

      nock(BASE_URL).get('/Patient').query({ _page: '2' }).reply(200, page2);

      const nextPage = await client.nextPage(page1);
      expect(nextPage).not.toBeNull();
      expect(nextPage!.entry![0].resource.id).toBe('p-2');
    });

    it('should return null when no next page', async () => {
      const lastPage: FHIRBundle<FHIRPatient> = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: 1,
        entry: [
          { resource: { resourceType: 'Patient', id: 'p-1' } },
        ],
      };

      const result = await client.nextPage(lastPage);
      expect(result).toBeNull();
    });
  });
});
