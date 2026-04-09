import { defaultRetryPolicy, criticalRetryPolicy, noRetryPolicy } from '../src/retry';

describe('Retry Policies', () => {
  describe('defaultRetryPolicy', () => {
    it('should have 5 max retries', () => {
      expect(defaultRetryPolicy.maxRetries).toBe(5);
    });

    it('should start at 1 second delay', () => {
      const delay = defaultRetryPolicy.getDelay(0);
      // With jitter, should be between 1000 and 1100
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1100);
    });

    it('should increase delay exponentially', () => {
      const delay0 = defaultRetryPolicy.initialDelayMs;
      const delay1 = defaultRetryPolicy.initialDelayMs * defaultRetryPolicy.backoffMultiplier;
      const delay2 = delay1 * defaultRetryPolicy.backoffMultiplier;

      // Each retry should roughly double (before jitter)
      expect(delay1).toBe(2000);
      expect(delay2).toBe(4000);
    });

    it('should not exceed max delay', () => {
      const delay = defaultRetryPolicy.getDelay(100); // Very high retry count
      expect(delay).toBeLessThanOrEqual(defaultRetryPolicy.maxDelayMs * 1.1); // Allow for jitter
    });

    it('should add jitter to prevent thundering herd', () => {
      // Run multiple times and check that values vary
      const delays = Array.from({ length: 10 }, () => defaultRetryPolicy.getDelay(2));
      const uniqueDelays = new Set(delays);
      // With jitter, we should get different values
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });
  });

  describe('criticalRetryPolicy', () => {
    it('should have 10 max retries', () => {
      expect(criticalRetryPolicy.maxRetries).toBe(10);
    });

    it('should start at 2 second delay', () => {
      const delay = criticalRetryPolicy.getDelay(0);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2200);
    });

    it('should cap at 5 minutes', () => {
      const delay = criticalRetryPolicy.getDelay(50);
      expect(delay).toBeLessThanOrEqual(300000 * 1.1);
    });
  });

  describe('noRetryPolicy', () => {
    it('should have 0 max retries', () => {
      expect(noRetryPolicy.maxRetries).toBe(0);
    });

    it('should return 0 delay', () => {
      expect(noRetryPolicy.getDelay(0)).toBe(0);
    });
  });
});

describe('EventBus', () => {
  // These tests require a RabbitMQ connection
  // In CI, we use a test container. Locally, use docker-compose.test.yml.
  // Marking as skip for unit test runs.

  it.todo('should connect to RabbitMQ');
  it.todo('should publish events');
  it.todo('should subscribe and receive events');
  it.todo('should handle reconnection');
  it.todo('should send failed messages to DLQ after max retries');
  it.todo('should handle serialization/deserialization');
});
