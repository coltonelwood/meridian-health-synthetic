/**
 * A/B Test: New Scheduling UX
 * =============================
 *
 * Test ID: AB-2025-007
 * Author: Sarah Chen (schen@meridianhealth.io)
 * Created: 2025-04-01
 * Concluded: 2025-07-15
 *
 * HYPOTHESIS:
 * The new drag-and-drop scheduling interface will reduce the time to book
 * an appointment by 30% and decrease scheduling errors by 50%.
 *
 * VARIANTS:
 *   Control (A): Current scheduling UI with dropdown-based time selection
 *   Treatment (B): New drag-and-drop UI with multi-provider calendar view
 *
 * RESULTS (concluded 2025-07-15):
 * =========================================
 *   Metric                    Control     Treatment    p-value    Significant?
 *   Time to book (median)     47s         28s          <0.001     YES
 *   Time to book (p95)        124s        72s          <0.001     YES
 *   Scheduling errors         3.2%        1.1%         <0.001     YES
 *   Double-bookings           0.8%        0.3%         0.012      YES
 *   Staff satisfaction (1-5)  3.2         4.1          <0.001     YES
 *   Patient no-show rate      12.1%       11.8%        0.42       NO
 *
 * DECISION: Roll out Treatment (B) to 100%. Completed 2025-09-01.
 *
 * NOTE: This code is kept for reference. The feature flag
 * 'new-scheduling-ui' is now at 100%.
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test configuration
const TEST_ID = 'AB-2025-007';
const TEST_START = new Date('2025-04-01');
const TEST_END = new Date('2025-07-15');
const VARIANTS = ['control', 'treatment'] as const;

interface TestMetrics {
  variant: string;
  sampleSize: number;
  timeToBookMedian: number;
  timeToBookP95: number;
  schedulingErrorRate: number;
  doubleBookingRate: number;
  noShowRate: number;
}

// -- Assignment --------------------------------------------------------------

/**
 * Assigns a user to a variant. Deterministic based on user ID.
 * @deprecated Test is concluded. Use feature flag 'new-scheduling-ui' instead.
 */
export function assignVariant(userId: string): typeof VARIANTS[number] {
  // Simple hash-based assignment - same as feature flag percentage
  const hash = Array.from(userId).reduce((acc, char) => {
    return ((acc << 5) - acc) + char.charCodeAt(0);
  }, 0);

  return Math.abs(hash) % 100 < 50 ? 'control' : 'treatment';
}

// -- Metric Collection -------------------------------------------------------

async function trackEvent(
  userId: string,
  variant: string,
  eventType: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await pool.query(`
    INSERT INTO ab_test_events (
      test_id, user_id, variant, event_type, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())
  `, [TEST_ID, userId, variant, eventType, JSON.stringify(metadata)]);
}

export async function trackBookingStarted(userId: string): Promise<void> {
  const variant = assignVariant(userId);
  await trackEvent(userId, variant, 'booking_started');
}

export async function trackBookingCompleted(
  userId: string,
  durationMs: number,
  appointmentId: string
): Promise<void> {
  const variant = assignVariant(userId);
  await trackEvent(userId, variant, 'booking_completed', {
    durationMs,
    appointmentId,
  });
}

export async function trackSchedulingError(
  userId: string,
  errorType: string,
  appointmentId?: string
): Promise<void> {
  const variant = assignVariant(userId);
  await trackEvent(userId, variant, 'scheduling_error', {
    errorType,
    appointmentId,
  });
}

// -- Analysis ----------------------------------------------------------------

async function computeMetrics(variant: string): Promise<TestMetrics> {
  // Time to book
  const bookingTimes = await pool.query(`
    SELECT
      e2.metadata->>'durationMs' as duration_ms
    FROM ab_test_events e1
    JOIN ab_test_events e2
      ON e1.user_id = e2.user_id
      AND e1.test_id = e2.test_id
    WHERE e1.test_id = $1
      AND e1.variant = $2
      AND e1.event_type = 'booking_started'
      AND e2.event_type = 'booking_completed'
      AND e1.created_at >= $3
      AND e1.created_at <= $4
    ORDER BY (e2.metadata->>'durationMs')::int
  `, [TEST_ID, variant, TEST_START, TEST_END]);

  const durations = bookingTimes.rows.map(r => parseInt(r.duration_ms));
  const medianIdx = Math.floor(durations.length / 2);
  const p95Idx = Math.floor(durations.length * 0.95);

  // Error rate
  const errorCount = await pool.query(`
    SELECT count(*) as cnt
    FROM ab_test_events
    WHERE test_id = $1 AND variant = $2 AND event_type = 'scheduling_error'
      AND created_at >= $3 AND created_at <= $4
  `, [TEST_ID, variant, TEST_START, TEST_END]);

  const totalBookings = await pool.query(`
    SELECT count(*) as cnt
    FROM ab_test_events
    WHERE test_id = $1 AND variant = $2 AND event_type = 'booking_completed'
      AND created_at >= $3 AND created_at <= $4
  `, [TEST_ID, variant, TEST_START, TEST_END]);

  const total = parseInt(totalBookings.rows[0].cnt);
  const errors = parseInt(errorCount.rows[0].cnt);

  // Double bookings
  const doubleBookings = await pool.query(`
    SELECT count(*) as cnt
    FROM ab_test_events
    WHERE test_id = $1 AND variant = $2 AND event_type = 'scheduling_error'
      AND metadata->>'errorType' = 'double_booking'
      AND created_at >= $3 AND created_at <= $4
  `, [TEST_ID, variant, TEST_START, TEST_END]);

  // No-show rate (checking against actual appointment outcomes)
  const noShows = await pool.query(`
    SELECT count(*) as no_shows, count(*) FILTER (WHERE a.status = 'no-show') as no_show_count
    FROM ab_test_events e
    JOIN appointments a ON a.id = (e.metadata->>'appointmentId')::uuid
    WHERE e.test_id = $1 AND e.variant = $2 AND e.event_type = 'booking_completed'
      AND a.appointment_date < NOW()
      AND e.created_at >= $3 AND e.created_at <= $4
  `, [TEST_ID, variant, TEST_START, TEST_END]);

  return {
    variant,
    sampleSize: total,
    timeToBookMedian: durations[medianIdx] || 0,
    timeToBookP95: durations[p95Idx] || 0,
    schedulingErrorRate: total > 0 ? errors / total : 0,
    doubleBookingRate: total > 0 ? parseInt(doubleBookings.rows[0].cnt) / total : 0,
    noShowRate: parseInt(noShows.rows[0].no_shows) > 0
      ? parseInt(noShows.rows[0].no_show_count) / parseInt(noShows.rows[0].no_shows)
      : 0,
  };
}

// -- Main (for generating the final report) ----------------------------------

async function main(): Promise<void> {
  console.log(`=== A/B Test Report: ${TEST_ID} ===`);
  console.log(`Test: New Scheduling UX`);
  console.log(`Period: ${TEST_START.toISOString().split('T')[0]} to ${TEST_END.toISOString().split('T')[0]}`);
  console.log('');

  for (const variant of VARIANTS) {
    const metrics = await computeMetrics(variant);

    console.log(`--- ${variant.toUpperCase()} ---`);
    console.log(`  Sample size:          ${metrics.sampleSize}`);
    console.log(`  Time to book (median): ${(metrics.timeToBookMedian / 1000).toFixed(1)}s`);
    console.log(`  Time to book (p95):    ${(metrics.timeToBookP95 / 1000).toFixed(1)}s`);
    console.log(`  Scheduling error rate: ${(metrics.schedulingErrorRate * 100).toFixed(1)}%`);
    console.log(`  Double booking rate:   ${(metrics.doubleBookingRate * 100).toFixed(1)}%`);
    console.log(`  No-show rate:          ${(metrics.noShowRate * 100).toFixed(1)}%`);
    console.log('');
  }

  console.log('STATUS: CONCLUDED - Treatment (B) rolled out to 100%');

  await pool.end();
}

if (require.main === module) {
  main().catch(console.error);
}
