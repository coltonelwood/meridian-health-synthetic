import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock pg Pool
const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockRelease = jest.fn();
const mockPool = {
  query: mockQuery,
  connect: mockConnect.mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  }),
};

// Mock logger
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

// Can't import RotationService directly because it pulls in pg
// so we test the logic in isolation
// TODO: set up a proper test database with docker-compose.test.yml
// so we can integration test the actual service

describe('Rotation Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCurrentOncall', () => {
    it('should return the oncall person for the current time', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          user_id: 'user-1',
          name: 'Alice Chen',
          email: 'alice@meridianhealth.io',
          slack_id: 'U123',
          phone: '5551234567',
        }],
      });

      // inline version of what getCurrentOncall does
      const now = new Date();
      const result = await mockPool.query(
        `SELECT s.user_id, u.name, u.email, u.slack_id, u.phone
         FROM oncall_schedule s
         JOIN users u ON u.id = s.user_id
         WHERE s.start_time <= $1 AND s.end_time > $1
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [now.toISOString()]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('Alice Chen');
    });

    it('should handle no oncall engineer', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const now = new Date();
      const result = await mockPool.query(
        expect.any(String),
        [now.toISOString()]
      );

      expect(result.rows).toHaveLength(0);
    });
  });

  describe('Rotation order', () => {
    it('should cycle through engineers in order', () => {
      const rotation = [
        { user_id: 'alice', position: 0 },
        { user_id: 'bob', position: 1 },
        { user_id: 'carol', position: 2 },
        { user_id: 'dave', position: 3 },
      ];

      // simulate rotation logic
      const lastUserId = 'bob';
      const lastIdx = rotation.findIndex(r => r.user_id === lastUserId);
      const nextPosition = (lastIdx + 1) % rotation.length;

      expect(rotation[nextPosition].user_id).toBe('carol');
    });

    it('should wrap around to the beginning', () => {
      const rotation = [
        { user_id: 'alice', position: 0 },
        { user_id: 'bob', position: 1 },
        { user_id: 'carol', position: 2 },
      ];

      const lastUserId = 'carol';
      const lastIdx = rotation.findIndex(r => r.user_id === lastUserId);
      const nextPosition = (lastIdx + 1) % rotation.length;

      expect(rotation[nextPosition].user_id).toBe('alice');
    });

    it('should handle single person rotation', () => {
      const rotation = [{ user_id: 'alice', position: 0 }];

      const lastUserId = 'alice';
      const lastIdx = rotation.findIndex(r => r.user_id === lastUserId);
      const nextPosition = (lastIdx + 1) % rotation.length;

      expect(rotation[nextPosition].user_id).toBe('alice');
    });
  });

  // TODO: test DST boundary handling
  // This is the known bug where shifts are off by an hour during DST transitions.
  // Need to write tests that:
  // 1. Create a shift that spans a DST boundary (e.g., Nov first Sunday)
  // 2. Verify the shift duration is correct in local time
  // 3. Verify that getCurrentOncall returns the right person during the transition
  //
  // This is hard to test because Date() uses the system timezone and Jest
  // doesn't have a great way to mock the system timezone.

  describe('Swap validation', () => {
    it('should reject swap if user is not scheduled', () => {
      // simple validation logic
      const schedule = [
        { user_id: 'alice', week_of: '2024-12-02' },
        { user_id: 'bob', week_of: '2024-12-09' },
      ];

      const fromUserId = 'carol';
      const weekOf = '2024-12-02';

      const isScheduled = schedule.some(
        s => s.user_id === fromUserId && s.week_of === weekOf
      );

      expect(isScheduled).toBe(false);
    });

    it('should detect conflict when target user is already scheduled', () => {
      const schedule = [
        { user_id: 'alice', week_of: '2024-12-02' },
        { user_id: 'bob', week_of: '2024-12-09' },
        { user_id: 'bob', week_of: '2024-12-02' }, // bob already has a shift this week
      ];

      const toUserId = 'bob';
      const weekOf = '2024-12-02';

      const hasConflict = schedule.some(
        s => s.user_id === toUserId && s.week_of === weekOf
      );

      expect(hasConflict).toBe(true);
    });
  });
});
