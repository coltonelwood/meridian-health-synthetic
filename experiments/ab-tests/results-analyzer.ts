/**
 * A/B Test Statistical Analysis
 * ===============================
 *
 * Author: Sarah Chen (schen@meridianhealth.io)
 * Created: 2025-03-20
 * Last Modified: 2025-11-08 by schen
 *
 * Generic statistical analysis tools for A/B tests. Provides:
 *   - Chi-squared test for proportions (e.g., conversion rates)
 *   - Welch's t-test for continuous metrics (e.g., time to complete)
 *   - Confidence interval calculation
 *   - Sample size estimation (power analysis)
 *
 * TODO(schen): Implement Bayesian analysis as an alternative to frequentist
 * methods. The product team keeps asking for "probability that B is better
 * than A" which is more natural with Bayesian inference. I started on it
 * (see the commented-out BayesianAnalyzer class at the bottom) but ran out
 * of time. The beta-binomial conjugate prior approach should work for
 * proportions. For continuous metrics we'd need MCMC which is more complex.
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// -- Statistical Functions ---------------------------------------------------

/**
 * Standard normal CDF approximation (Abramowitz and Stegun)
 * Good enough for our purposes. Error < 7.5e-8.
 */
function normalCDF(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Inverse normal CDF (for confidence intervals)
 * Uses the rational approximation from Abramowitz and Stegun
 */
function normalInverseCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Coefficients for the rational approximation
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01
  ];

  const q = p < 0.5 ? p : 1 - p;
  const r = Math.sqrt(-2 * Math.log(q));

  let x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) /
           ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);

  if (p < 0.5) x = -x;
  return x;
}

/**
 * Chi-squared CDF (1 degree of freedom)
 * For comparing proportions between two groups
 */
function chiSquaredCDF1df(x: number): number {
  // Chi-squared with 1 df is just the square of a standard normal
  return 2 * normalCDF(Math.sqrt(x)) - 1;
}

// -- Test Types --------------------------------------------------------------

interface ProportionTestInput {
  controlSuccesses: number;
  controlTotal: number;
  treatmentSuccesses: number;
  treatmentTotal: number;
}

interface ProportionTestResult {
  controlRate: number;
  treatmentRate: number;
  absoluteDifference: number;
  relativeDifference: number;
  chiSquared: number;
  pValue: number;
  isSignificant: boolean;
  confidenceLevel: number;
  controlCI: [number, number];
  treatmentCI: [number, number];
}

interface ContinuousTestInput {
  controlValues: number[];
  treatmentValues: number[];
}

interface ContinuousTestResult {
  controlMean: number;
  controlMedian: number;
  controlStdDev: number;
  treatmentMean: number;
  treatmentMedian: number;
  treatmentStdDev: number;
  absoluteDifference: number;
  relativeDifference: number;
  tStatistic: number;
  degreesOfFreedom: number;
  pValue: number;
  isSignificant: boolean;
  confidenceLevel: number;
  controlCI: [number, number];
  treatmentCI: [number, number];
}

// -- Proportion Test (Chi-Squared) -------------------------------------------

export function proportionTest(
  input: ProportionTestInput,
  confidenceLevel: number = 0.95
): ProportionTestResult {
  const { controlSuccesses, controlTotal, treatmentSuccesses, treatmentTotal } = input;

  const controlRate = controlSuccesses / controlTotal;
  const treatmentRate = treatmentSuccesses / treatmentTotal;

  // Pooled proportion under H0
  const pooledRate = (controlSuccesses + treatmentSuccesses) / (controlTotal + treatmentTotal);
  const pooledQ = 1 - pooledRate;

  // Chi-squared statistic
  const standardError = Math.sqrt(
    pooledRate * pooledQ * (1 / controlTotal + 1 / treatmentTotal)
  );

  const z = (treatmentRate - controlRate) / standardError;
  const chiSquared = z * z;

  // p-value (two-tailed)
  const pValue = 1 - chiSquaredCDF1df(chiSquared);

  // Confidence intervals for each rate
  const zAlpha = normalInverseCDF(1 - (1 - confidenceLevel) / 2);

  const controlSE = Math.sqrt(controlRate * (1 - controlRate) / controlTotal);
  const treatmentSE = Math.sqrt(treatmentRate * (1 - treatmentRate) / treatmentTotal);

  return {
    controlRate,
    treatmentRate,
    absoluteDifference: treatmentRate - controlRate,
    relativeDifference: controlRate > 0 ? (treatmentRate - controlRate) / controlRate : 0,
    chiSquared,
    pValue,
    isSignificant: pValue < (1 - confidenceLevel),
    confidenceLevel,
    controlCI: [
      Math.max(0, controlRate - zAlpha * controlSE),
      Math.min(1, controlRate + zAlpha * controlSE),
    ],
    treatmentCI: [
      Math.max(0, treatmentRate - zAlpha * treatmentSE),
      Math.min(1, treatmentRate + zAlpha * treatmentSE),
    ],
  };
}

// -- Continuous Test (Welch's t-test) ----------------------------------------

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values: number[]): number {
  const m = mean(values);
  const squaredDiffs = values.map(v => (v - m) ** 2);
  return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1));
}

export function continuousTest(
  input: ContinuousTestInput,
  confidenceLevel: number = 0.95
): ContinuousTestResult {
  const { controlValues, treatmentValues } = input;

  const cMean = mean(controlValues);
  const tMean = mean(treatmentValues);
  const cStd = stddev(controlValues);
  const tStd = stddev(treatmentValues);
  const cN = controlValues.length;
  const tN = treatmentValues.length;

  // Welch's t-test (doesn't assume equal variances)
  const se = Math.sqrt((cStd ** 2 / cN) + (tStd ** 2 / tN));
  const tStatistic = (tMean - cMean) / se;

  // Welch-Satterthwaite degrees of freedom
  const df = Math.floor(
    ((cStd ** 2 / cN + tStd ** 2 / tN) ** 2) /
    ((cStd ** 2 / cN) ** 2 / (cN - 1) + (tStd ** 2 / tN) ** 2 / (tN - 1))
  );

  // Approximate p-value using normal distribution for large samples
  // (proper implementation would use t-distribution CDF)
  // This is a reasonable approximation when df > 30 which it always is
  // for our A/B tests (thousands of samples)
  const pValue = 2 * (1 - normalCDF(Math.abs(tStatistic)));

  const zAlpha = normalInverseCDF(1 - (1 - confidenceLevel) / 2);

  return {
    controlMean: cMean,
    controlMedian: median(controlValues),
    controlStdDev: cStd,
    treatmentMean: tMean,
    treatmentMedian: median(treatmentValues),
    treatmentStdDev: tStd,
    absoluteDifference: tMean - cMean,
    relativeDifference: cMean !== 0 ? (tMean - cMean) / cMean : 0,
    tStatistic,
    degreesOfFreedom: df,
    pValue,
    isSignificant: pValue < (1 - confidenceLevel),
    confidenceLevel,
    controlCI: [cMean - zAlpha * cStd / Math.sqrt(cN), cMean + zAlpha * cStd / Math.sqrt(cN)],
    treatmentCI: [tMean - zAlpha * tStd / Math.sqrt(tN), tMean + zAlpha * tStd / Math.sqrt(tN)],
  };
}

// -- Sample Size Calculator --------------------------------------------------

/**
 * Calculate minimum sample size per group for a proportion test.
 * Uses the formula for two-proportioned z-test.
 */
export function requiredSampleSize(
  baselineRate: number,
  minimumDetectableEffect: number,  // relative change, e.g., 0.2 = 20% improvement
  power: number = 0.8,
  significanceLevel: number = 0.05
): number {
  const p1 = baselineRate;
  const p2 = baselineRate * (1 + minimumDetectableEffect);

  const zAlpha = normalInverseCDF(1 - significanceLevel / 2);
  const zBeta = normalInverseCDF(power);

  const pBar = (p1 + p2) / 2;

  const n = ((zAlpha * Math.sqrt(2 * pBar * (1 - pBar)) + zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) /
    ((p2 - p1) ** 2);

  return Math.ceil(n);
}

// -- Report Generator --------------------------------------------------------

export async function generateReport(testId: string): Promise<void> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  A/B Test Report: ${testId}`);
  console.log(`  Generated: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(70)}\n`);

  // Get test metadata
  const testMeta = await pool.query(`
    SELECT
      MIN(created_at) as start_date,
      MAX(created_at) as latest_event,
      count(DISTINCT user_id) as unique_users,
      count(*) as total_events
    FROM ab_test_events
    WHERE test_id = $1
  `, [testId]);

  const meta = testMeta.rows[0];
  console.log(`Start date: ${meta.start_date}`);
  console.log(`Latest event: ${meta.latest_event}`);
  console.log(`Unique users: ${meta.unique_users}`);
  console.log(`Total events: ${meta.total_events}`);
  console.log('');

  // Get variant sizes
  const variantSizes = await pool.query(`
    SELECT variant, count(DISTINCT user_id) as users, count(*) as events
    FROM ab_test_events
    WHERE test_id = $1
    GROUP BY variant
  `, [testId]);

  console.log('Variant distribution:');
  for (const row of variantSizes.rows) {
    console.log(`  ${row.variant}: ${row.users} users, ${row.events} events`);
  }
  console.log('');

  // Get unique event types for this test
  const eventTypes = await pool.query(`
    SELECT event_type, variant, count(*) as cnt
    FROM ab_test_events
    WHERE test_id = $1
    GROUP BY event_type, variant
    ORDER BY event_type, variant
  `, [testId]);

  console.log('Event counts by type:');
  console.log(`  ${'Event Type'.padEnd(30)} ${'Control'.padStart(10)} ${'Treatment'.padStart(10)}`);
  console.log(`  ${'-'.repeat(50)}`);

  const eventMap: Record<string, Record<string, number>> = {};
  for (const row of eventTypes.rows) {
    if (!eventMap[row.event_type]) eventMap[row.event_type] = {};
    eventMap[row.event_type][row.variant] = parseInt(row.cnt);
  }

  for (const [eventType, variants] of Object.entries(eventMap)) {
    console.log(`  ${eventType.padEnd(30)} ${String(variants['control'] || 0).padStart(10)} ${String(variants['treatment'] || 0).padStart(10)}`);
  }

  console.log('');
  console.log('NOTE: For detailed metric analysis, use the proportionTest() and');
  console.log('continuousTest() functions with your specific metrics.');
}

// -- CLI ---------------------------------------------------------------------

if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'report': {
      const testId = process.argv[3];
      if (!testId) { console.error('Usage: ... report <test-id>'); process.exit(1); }
      generateReport(testId).then(() => pool.end()).catch(console.error);
      break;
    }

    case 'sample-size': {
      const baseline = parseFloat(process.argv[3] || '0.1');
      const mde = parseFloat(process.argv[4] || '0.2');
      const n = requiredSampleSize(baseline, mde);
      console.log(`Baseline rate: ${(baseline * 100).toFixed(1)}%`);
      console.log(`Minimum detectable effect: ${(mde * 100).toFixed(1)}% relative`);
      console.log(`Required sample size per group: ${n}`);
      console.log(`Total required: ${n * 2}`);
      pool.end();
      break;
    }

    case 'demo': {
      // Quick demo with fake data
      console.log('=== Proportion Test Demo ===');
      const propResult = proportionTest({
        controlSuccesses: 120,
        controlTotal: 1500,
        treatmentSuccesses: 95,
        treatmentTotal: 1500,
      });
      console.log(`Control rate: ${(propResult.controlRate * 100).toFixed(2)}%`);
      console.log(`Treatment rate: ${(propResult.treatmentRate * 100).toFixed(2)}%`);
      console.log(`Relative change: ${(propResult.relativeDifference * 100).toFixed(1)}%`);
      console.log(`p-value: ${propResult.pValue.toFixed(4)}`);
      console.log(`Significant: ${propResult.isSignificant}`);
      console.log('');

      console.log('=== Continuous Test Demo ===');
      // Simulate booking times
      const controlTimes = Array.from({ length: 500 }, () => 40 + Math.random() * 30);
      const treatmentTimes = Array.from({ length: 500 }, () => 25 + Math.random() * 25);
      const contResult = continuousTest({ controlValues: controlTimes, treatmentValues: treatmentTimes });
      console.log(`Control mean: ${contResult.controlMean.toFixed(1)}s`);
      console.log(`Treatment mean: ${contResult.treatmentMean.toFixed(1)}s`);
      console.log(`Relative change: ${(contResult.relativeDifference * 100).toFixed(1)}%`);
      console.log(`p-value: ${contResult.pValue.toFixed(6)}`);
      console.log(`Significant: ${contResult.isSignificant}`);

      pool.end();
      break;
    }

    default:
      console.log('Usage: npx tsx results-analyzer.ts <report|sample-size|demo>');
      console.log('');
      console.log('Commands:');
      console.log('  report <test-id>            Generate report for an A/B test');
      console.log('  sample-size <baseline> <mde> Calculate required sample size');
      console.log('  demo                        Run with fake data');
      pool.end();
  }
}

// -- TODO: Bayesian Analysis -------------------------------------------------
// schen 2025-11-08: Started implementing this, not ready yet
//
// class BayesianAnalyzer {
//   // Beta-binomial conjugate prior for proportion tests
//   // Prior: Beta(alpha=1, beta=1) = uniform (uninformative)
//
//   private alphaPrior: number = 1;
//   private betaPrior: number = 1;
//
//   // After observing `successes` out of `total`:
//   // Posterior: Beta(alpha + successes, beta + failures)
//
//   getPosterior(successes: number, total: number): { alpha: number; beta: number } {
//     return {
//       alpha: this.alphaPrior + successes,
//       beta: this.betaPrior + (total - successes),
//     };
//   }
//
//   // P(treatment > control) via Monte Carlo simulation
//   // Draw samples from both posteriors and count how often treatment > control
//   probabilityBBeatsA(
//     controlSuccesses: number, controlTotal: number,
//     treatmentSuccesses: number, treatmentTotal: number,
//     numSamples: number = 100000
//   ): number {
//     const controlPosterior = this.getPosterior(controlSuccesses, controlTotal);
//     const treatmentPosterior = this.getPosterior(treatmentSuccesses, treatmentTotal);
//
//     let bWins = 0;
//     for (let i = 0; i < numSamples; i++) {
//       const controlSample = betaRandom(controlPosterior.alpha, controlPosterior.beta);
//       const treatmentSample = betaRandom(treatmentPosterior.alpha, treatmentPosterior.beta);
//       if (treatmentSample > controlSample) bWins++;
//     }
//
//     return bWins / numSamples;
//   }
// }
//
// // TODO: implement betaRandom() - need a Beta distribution sampler
// // Could use the Joehnk algorithm or transform from Gamma samples
// // function betaRandom(alpha: number, beta: number): number { ... }
