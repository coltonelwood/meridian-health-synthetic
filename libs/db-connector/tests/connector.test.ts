/**
 * Database connector tests.
 *
 * These are unit tests that mock the pg module.
 * Integration tests that actually connect to PostgreSQL are in
 * the integration test suite (run separately with a test database).
 */

import { checkDatabaseHealth } from '../src/health';

// Mock pg module
jest.mock('pg', () => {
  const mockPool = {
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0,
  };

  return {
    Pool: jest.fn(() => mockPool),
    __mockPool: mockPool,
  };
});

const { __mockPool: mockPool } = require('pg');

describe('checkDatabaseHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return healthy status when database is responsive', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const status = await checkDatabaseHealth(mockPool);

    expect(status.healthy).toBe(true);
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.poolSize).toBe(10);
    expect(status.activeConnections).toBe(5);
    expect(status.idleConnections).toBe(5);
  });

  it('should return unhealthy when database query fails', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));

    const status = await checkDatabaseHealth(mockPool);

    expect(status.healthy).toBe(false);
    expect(status.error).toBe('Connection refused');
  });

  it('should report unhealthy when clients are waiting', async () => {
    mockPool.waitingCount = 5;
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const status = await checkDatabaseHealth(mockPool);

    expect(status.healthy).toBe(false);
    expect(status.waitingClients).toBe(5);
    expect(status.error).toContain('waiting');

    // Reset
    mockPool.waitingCount = 0;
  });
});

describe('Connection retry logic', () => {
  // These would be integration tests in a real setup
  it('should be tested with a real database connection', () => {
    // Placeholder - actual retry tests need a database
    expect(true).toBe(true);
  });
});

describe('Transaction support', () => {
  it('should be tested with a real database connection', () => {
    // Placeholder - transaction tests need a database
    expect(true).toBe(true);
  });
});
