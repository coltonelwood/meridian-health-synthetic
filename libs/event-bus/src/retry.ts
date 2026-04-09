/**
 * Event retry logic with exponential backoff.
 *
 * When an event handler fails, the message is retried with increasing
 * delays. After max retries, it goes to the dead letter queue (DLQ).
 *
 * DLQ messages are reviewed by the platform team and either:
 * 1. Fixed and replayed
 * 2. Acknowledged as unrecoverable (logged for audit)
 *
 * Current DLQ review cadence: daily (automated alerts when DLQ depth > 10)
 */

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  getDelay: (retryCount: number) => number;
}

/**
 * Default retry policy:
 * - 5 retries
 * - Starting at 1 second
 * - Exponential backoff (2x)
 * - Max delay: 60 seconds
 *
 * Retry schedule:
 * 1st retry: 1s
 * 2nd retry: 2s
 * 3rd retry: 4s
 * 4th retry: 8s
 * 5th retry: 16s
 * Total: ~31 seconds before DLQ
 */
export const defaultRetryPolicy: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,

  getDelay(retryCount: number): number {
    const delay = this.initialDelayMs * Math.pow(this.backoffMultiplier, retryCount);
    // Add jitter (10% random variance) to prevent thundering herd
    const jitter = delay * 0.1 * Math.random();
    return Math.min(delay + jitter, this.maxDelayMs);
  },
};

/**
 * Aggressive retry policy for critical events (e.g., claim processing).
 * More retries with longer delays.
 */
export const criticalRetryPolicy: RetryPolicy = {
  maxRetries: 10,
  initialDelayMs: 2000,
  maxDelayMs: 300000, // 5 minutes
  backoffMultiplier: 2,

  getDelay(retryCount: number): number {
    const delay = this.initialDelayMs * Math.pow(this.backoffMultiplier, retryCount);
    const jitter = delay * 0.1 * Math.random();
    return Math.min(delay + jitter, this.maxDelayMs);
  },
};

/**
 * No retry policy (for events that should fail fast).
 */
export const noRetryPolicy: RetryPolicy = {
  maxRetries: 0,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
  getDelay: () => 0,
};
