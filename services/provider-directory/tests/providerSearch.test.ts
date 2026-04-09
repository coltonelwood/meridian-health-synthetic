import { providerSearch } from '../src/services/providerSearch';

// Mock Elasticsearch client
const mockSearch = jest.fn();
const mockCluster = { health: jest.fn() };

// Mock the global ES client
(global as any).__esClient = {
  search: mockSearch,
  cluster: mockCluster,
};

// Mock postgres pool
const mockQuery = jest.fn();
(global as any).__pgPool = {
  query: mockQuery,
};

(global as any).__logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe('providerSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Elasticsearch search', () => {
    it('should search by name query', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          total: { value: 2 },
          hits: [
            {
              _id: 'provider-1',
              _score: 5.2,
              _source: {
                npi: '1234567890',
                first_name: 'John',
                last_name: 'Smith',
                display_name: 'Dr. John Smith, MD',
                specialty: ['Internal Medicine'],
                accepting_new_patients: true,
              },
              highlight: {
                display_name: ['Dr. <em>John</em> <em>Smith</em>, MD'],
              },
            },
            {
              _id: 'provider-2',
              _score: 3.1,
              _source: {
                npi: '9876543210',
                first_name: 'Jane',
                last_name: 'Smith',
                display_name: 'Dr. Jane Smith, DO',
                specialty: ['Family Medicine'],
                accepting_new_patients: true,
              },
              highlight: {
                display_name: ['Dr. Jane <em>Smith</em>, DO'],
              },
            },
          ],
        },
      });

      const result = await providerSearch({
        query: 'Smith',
        page: 1,
        page_size: 20,
        sort: 'relevance',
      });

      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.source).toBe('elasticsearch');
      expect(result.results[0].provider.last_name).toBe('Smith');
      expect(result.results[0].score).toBe(5.2);

      // Verify ES was called with correct query structure
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'providers',
        })
      );

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.filter).toContainEqual({
        term: { status: 'active' },
      });
    });

    it('should filter by specialty', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          total: { value: 1 },
          hits: [
            {
              _id: 'provider-3',
              _score: 1.0,
              _source: {
                npi: '5555555555',
                display_name: 'Dr. Cardiologist',
                specialty: ['Cardiovascular Disease'],
              },
            },
          ],
        },
      });

      const result = await providerSearch({
        specialty: 'Cardiovascular Disease',
        page: 1,
        page_size: 20,
        sort: 'relevance',
      });

      expect(result.total).toBe(1);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.filter).toContainEqual({
        term: { specialty: 'Cardiovascular Disease' },
      });
    });

    it('should search with geo-distance filter', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          total: { value: 3 },
          hits: [
            {
              _id: 'provider-near',
              _score: 2.0,
              _source: {
                npi: '1111111111',
                display_name: 'Nearby Doctor',
                location: { lat: 40.7128, lon: -74.006 },
              },
              fields: {
                distance_miles: [1.2],
              },
            },
          ],
        },
      });

      const result = await providerSearch({
        location: {
          lat: 40.7128,
          lng: -74.006,
          radius_miles: 10,
        },
        page: 1,
        page_size: 20,
        sort: 'distance',
      });

      expect(result.results[0].distance_miles).toBe(1.2);

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.query.bool.filter).toContainEqual(
        expect.objectContaining({
          geo_distance: expect.objectContaining({
            distance: '10mi',
          }),
        })
      );

      // Should have geo_distance sort
      expect(searchBody.sort[0]).toHaveProperty('_geo_distance');
    });

    it('should combine multiple filters', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          total: { value: 0 },
          hits: [],
        },
      });

      await providerSearch({
        query: 'smith',
        specialty: 'Dermatology',
        accepting_new_patients: true,
        gender: 'F',
        language: 'spanish',
        telehealth_available: true,
        page: 1,
        page_size: 10,
        sort: 'relevance',
      });

      const searchBody = mockSearch.mock.calls[0][0].body;
      const filters = searchBody.query.bool.filter;

      expect(filters).toContainEqual({ term: { status: 'active' } });
      expect(filters).toContainEqual({ term: { specialty: 'Dermatology' } });
      expect(filters).toContainEqual({ term: { accepting_new_patients: true } });
      expect(filters).toContainEqual({ term: { gender: 'F' } });
      expect(filters).toContainEqual({ term: { languages: 'spanish' } });
      expect(filters).toContainEqual({ term: { telehealth_available: true } });
    });

    it('should handle pagination', async () => {
      mockSearch.mockResolvedValue({
        hits: {
          total: { value: 100 },
          hits: [],
        },
      });

      await providerSearch({
        page: 3,
        page_size: 25,
        sort: 'relevance',
      });

      const searchBody = mockSearch.mock.calls[0][0].body;
      expect(searchBody.from).toBe(50); // (3-1) * 25
      expect(searchBody.size).toBe(25);
    });
  });

  describe('Postgres fallback', () => {
    it('should fall back to postgres when ES is unavailable', async () => {
      mockSearch.mockRejectedValue(new Error('connect ECONNREFUSED'));

      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // count query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pg-provider-1',
              npi: '1234567890',
              display_name: 'Dr. Postgres',
              first_name: 'Post',
              last_name: 'Gres',
            },
          ],
        }); // data query

      const result = await providerSearch({
        query: 'Postgres',
        page: 1,
        page_size: 20,
        sort: 'name',
      });

      expect(result.source).toBe('postgres');
      expect(result.total).toBe(5);
      expect(result.results[0].provider.display_name).toBe('Dr. Postgres');
    });

    // TODO: test geo fallback with bounding box
    // TODO: test specialty filter with subquery
    // These are harder to test because the SQL is dynamically built
    // and we'd need to parse it. Skipping for now.
  });
});
