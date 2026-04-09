import { ConflictDetector } from '../src/services/conflictDetector';
import { pool } from '../src/db';

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe('ConflictDetector', () => {
  let detector: ConflictDetector;

  beforeEach(() => {
    jest.clearAllMocks();
    detector = new ConflictDetector();
  });

  describe('checkConflicts', () => {
    const baseParams = {
      providerId: '550e8400-e29b-41d4-a716-446655440001',
      patientId: '550e8400-e29b-41d4-a716-446655440002',
      startTime: new Date('2025-03-15T14:00:00Z'),
      endTime: new Date('2025-03-15T14:30:00Z'),
    };

    it('should return empty array when no conflicts exist', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })  // provider check
        .mockResolvedValueOnce({ rows: [] }); // patient check

      const conflicts = await detector.checkConflicts(baseParams);

      expect(conflicts).toHaveLength(0);
    });

    it('should detect provider double-booking', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{
            id: 'existing-appt',
            start_time: new Date('2025-03-15T13:45:00Z'),
            end_time: new Date('2025-03-15T14:15:00Z'),
            patient_id: 'other-patient',
            type: 'follow_up',
          }],
        })
        .mockResolvedValueOnce({ rows: [] }); // patient check

      const conflicts = await detector.checkConflicts(baseParams);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflictType).toBe('provider');
    });

    it('should detect patient double-booking', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // provider check
        .mockResolvedValueOnce({
          rows: [{
            id: 'other-appt',
            start_time: new Date('2025-03-15T14:00:00Z'),
            end_time: new Date('2025-03-15T15:00:00Z'),
            provider_id: 'other-provider',
            type: 'annual_physical',
          }],
        });

      const conflicts = await detector.checkConflicts(baseParams);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflictType).toBe('patient');
    });

    it('should detect both provider and patient conflicts simultaneously', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{
            id: 'prov-conflict',
            start_time: new Date('2025-03-15T13:30:00Z'),
            end_time: new Date('2025-03-15T14:30:00Z'),
            patient_id: 'some-patient',
            type: 'follow_up',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'pat-conflict',
            start_time: new Date('2025-03-15T14:00:00Z'),
            end_time: new Date('2025-03-15T15:00:00Z'),
            provider_id: 'some-provider',
            type: 'lab_work',
          }],
        });

      const conflicts = await detector.checkConflicts(baseParams);

      expect(conflicts).toHaveLength(2);
      expect(conflicts.map(c => c.conflictType)).toEqual(['provider', 'patient']);
    });

    it('should NOT conflict when appointments are adjacent (back-to-back)', async () => {
      // Appointment ends at exactly the same time the new one starts
      // This should NOT be a conflict
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{
            id: 'adjacent-appt',
            start_time: new Date('2025-03-15T13:30:00Z'),
            end_time: new Date('2025-03-15T14:00:00Z'), // ends when new one starts
            patient_id: 'other-patient',
            type: 'follow_up',
          }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const conflicts = await detector.checkConflicts(baseParams);

      // NOTE: whether this passes depends on the comparison operators
      // used in the SQL query. If we use < and >, it won't conflict.
      // If we use <= and >=, it will conflict.
      // Currently using < and >, so adjacent appointments are OK.
      expect(conflicts).toHaveLength(0);
    });

    it('should exclude specified appointment ID (for updates)', async () => {
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await detector.checkConflicts({
        ...baseParams,
        excludeAppointmentId: 'self-id',
      });

      // Verify the query included the exclude clause
      const providerCall = (mockPool.query as jest.Mock).mock.calls[0];
      expect(providerCall[0]).toContain('id !=');
      expect(providerCall[1]).toContain('self-id');
    });

    it('should not flag cancelled appointments as conflicts', async () => {
      // The SQL query should filter out cancelled appointments
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const conflicts = await detector.checkConflicts(baseParams);

      // Verify the query includes the status filter
      const queryStr = (mockPool.query as jest.Mock).mock.calls[0][0];
      expect(queryStr).toContain("NOT IN ('cancelled'");

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('findNearestAvailable', () => {
    it('should find the next available slot', async () => {
      // First check: conflicts exist
      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ id: 'conflict', start_time: new Date('2025-03-15T14:00:00Z'), end_time: new Date('2025-03-15T14:30:00Z'), patient_id: 'p', type: 'f' }],
        })
        .mockResolvedValueOnce({ rows: [] })
        // Second check (15 min later): no conflicts
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await detector.findNearestAvailable(
        'prov-001',
        'pat-001',
        new Date('2025-03-15T14:00:00Z'),
        30,
      );

      expect(result).not.toBeNull();
      // The next available should be 15 minutes later
      // (since we search in 15-minute increments)
      if (result) {
        expect(new Date(result.start).getTime()).toBeGreaterThan(
          new Date('2025-03-15T14:00:00Z').getTime()
        );
      }
    });

    it('should return null if no slots available within search window', async () => {
      // Always return conflicts
      (mockPool.query as jest.Mock).mockResolvedValue({
        rows: [{ id: 'always-busy', start_time: new Date(), end_time: new Date(), patient_id: 'p', type: 'f' }],
      });

      const result = await detector.findNearestAvailable(
        'prov-001',
        'pat-001',
        new Date('2025-03-15T14:00:00Z'),
        30,
        1, // only search 1 day
      );

      // Will hit MAX_ITERATIONS and return null
      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    // TODO: add tests for these edge cases
    it.todo('should handle appointments spanning midnight');
    it.todo('should handle timezone boundary conflicts');
    it.todo('should handle provider working at multiple locations');
    it.todo('should handle very long appointments (e.g., 8-hour surgery)');
  });
});
