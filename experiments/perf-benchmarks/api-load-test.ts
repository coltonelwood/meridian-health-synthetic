/**
 * API Load Testing Script
 * ========================
 *
 * Author: David Holmes (dholmes@meridianhealth.io)
 * Created: 2025-01-10
 * Last Modified: 2025-12-15 by dholmes
 *
 * Custom load testing script for Meridian API endpoints. We used to use k6
 * but switched to a custom script because we needed to:
 *   1. Generate realistic healthcare data for request bodies
 *   2. Chain requests (e.g., create patient -> book appointment -> submit claim)
 *   3. Test against our auth flow (OAuth2 + SMART on FHIR)
 *
 * Usage:
 *   npx tsx experiments/perf-benchmarks/api-load-test.ts --target staging --scenario smoke
 *   npx tsx experiments/perf-benchmarks/api-load-test.ts --target staging --scenario load --rps 50 --duration 300
 *   npx tsx experiments/perf-benchmarks/api-load-test.ts --target staging --scenario stress --rps 200 --duration 600
 *
 * RESULTS FROM LAST RUN (2025-12-15, staging, load test, 50 rps, 5 min):
 * =========================================================================
 * Endpoint                          p50     p95     p99     Errors
 * GET  /api/v2/patients             12ms    45ms    120ms   0.00%
 * GET  /api/v2/patients/:id         8ms     22ms    55ms    0.00%
 * POST /api/v2/patients             35ms    95ms    210ms   0.02%
 * GET  /api/v2/appointments         18ms    65ms    180ms   0.00%
 * POST /api/v2/appointments         42ms    110ms   285ms   0.01%
 * GET  /api/v2/claims               25ms    85ms    250ms   0.00%
 * POST /api/v2/claims               55ms    180ms   450ms   0.05%    <-- needs optimization
 * GET  /api/v2/claims/:id/status    6ms     15ms    35ms    0.00%
 * POST /api/v2/eligibility/check    180ms   450ms   1200ms  0.10%    <-- external API dependency
 * GET  /api/v2/providers            15ms    40ms    95ms    0.00%
 * POST /api/v2/encounters           48ms    130ms   320ms   0.03%
 *
 * NOTES:
 * - POST /claims p99 is higher than we'd like (target: <300ms)
 *   The bottleneck is claim validation which does 3 DB lookups sequentially.
 *   Filed PERF-512 to parallelize them.
 * - Eligibility check latency is dominated by the external payer API call.
 *   Not much we can do about that. We have a cache (TTL 24h) that helps
 *   for repeat checks.
 */

import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';

// -- Configuration -----------------------------------------------------------

const TARGETS: Record<string, string> = {
  local: 'http://localhost:3000',
  staging: 'https://api.staging.meridianhealth.io',
  // DO NOT add production here. Load tests against production are forbidden.
  // (yes, someone tried it once. It went poorly. INC-1205.)
};

const SCENARIOS: Record<string, { rps: number; duration: number; warmup: number }> = {
  smoke: { rps: 5, duration: 30, warmup: 5 },
  load: { rps: 50, duration: 300, warmup: 30 },
  stress: { rps: 200, duration: 600, warmup: 60 },
  spike: { rps: 500, duration: 60, warmup: 0 },  // instant spike, for testing autoscaling
};

// Parse CLI args
const args = process.argv.slice(2);
let targetEnv = 'staging';
let scenario = 'smoke';
let overrideRps = 0;
let overrideDuration = 0;
let authToken = process.env.LOAD_TEST_API_TOKEN || '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target') targetEnv = args[++i];
  if (args[i] === '--scenario') scenario = args[++i];
  if (args[i] === '--rps') overrideRps = parseInt(args[++i]);
  if (args[i] === '--duration') overrideDuration = parseInt(args[++i]);
  if (args[i] === '--token') authToken = args[++i];
}

const baseUrl = TARGETS[targetEnv];
if (!baseUrl) {
  console.error(`Unknown target: ${targetEnv}. Valid targets: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

const config = SCENARIOS[scenario] || SCENARIOS.smoke;
if (overrideRps) config.rps = overrideRps;
if (overrideDuration) config.duration = overrideDuration;

// -- HTTP Client with metrics ------------------------------------------------

interface RequestMetrics {
  endpoint: string;
  method: string;
  statusCode: number;
  durationMs: number;
  timestamp: number;
  error?: string;
}

const allMetrics: RequestMetrics[] = [];

async function makeRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<RequestMetrics> {
  const url = new URL(path, baseUrl);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'X-Request-ID': randomUUID(),
        'X-Load-Test': 'true',  // so our middleware can identify and tag load test traffic
      },
    };

    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const metrics: RequestMetrics = {
          endpoint: `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`,  // normalize UUIDs
          method,
          statusCode: res.statusCode || 0,
          durationMs: Date.now() - startTime,
          timestamp: startTime,
        };

        if (res.statusCode && res.statusCode >= 400) {
          metrics.error = `HTTP ${res.statusCode}`;
        }

        allMetrics.push(metrics);
        resolve(metrics);
      });
    });

    req.on('error', (err) => {
      const metrics: RequestMetrics = {
        endpoint: `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`,
        method,
        statusCode: 0,
        durationMs: Date.now() - startTime,
        timestamp: startTime,
        error: err.message,
      };
      allMetrics.push(metrics);
      resolve(metrics);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      const metrics: RequestMetrics = {
        endpoint: `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`,
        method,
        statusCode: 0,
        durationMs: Date.now() - startTime,
        timestamp: startTime,
        error: 'timeout',
      };
      allMetrics.push(metrics);
      resolve(metrics);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// -- Test Scenarios ----------------------------------------------------------

// Generate fake but realistic-ish data for requests
function generatePatientBody(): Record<string, unknown> {
  return {
    firstName: `LoadTest${Math.random().toString(36).slice(2, 8)}`,
    lastName: `User${Math.random().toString(36).slice(2, 8)}`,
    dateOfBirth: '1985-03-15',
    gender: 'F',
    email: `loadtest+${randomUUID().slice(0, 8)}@meridianhealth.io`,
    phone: '555-0100',
    address: {
      line1: '123 Test Street',
      city: 'Testville',
      state: 'CA',
      zipCode: '90210',
    },
    insurance: {
      payerId: 'BCBS001',
      memberId: `LT${Math.random().toString().slice(2, 14)}`,
      groupNumber: 'LOADTEST',
    },
  };
}

function generateClaimBody(patientId: string, providerId: string): Record<string, unknown> {
  return {
    patientId,
    providerId,
    dateOfService: new Date().toISOString().split('T')[0],
    payerId: 'BCBS001',
    lines: [
      {
        cptCode: '99213',
        icd10Codes: ['J06.9'],
        units: 1,
        chargeAmount: 95.00,
        placeOfService: '11',
      },
    ],
  };
}

// Available request generators (randomly selected during the test)
const REQUEST_GENERATORS = [
  { weight: 20, name: 'GET /patients', fn: () => makeRequest('GET', '/api/v2/patients?limit=20') },
  { weight: 15, name: 'GET /patients/:id', fn: () => makeRequest('GET', `/api/v2/patients/${randomUUID()}`) },
  { weight: 5,  name: 'POST /patients', fn: () => makeRequest('POST', '/api/v2/patients', generatePatientBody()) },
  { weight: 15, name: 'GET /appointments', fn: () => makeRequest('GET', '/api/v2/appointments?date=2025-12-15&limit=50') },
  { weight: 5,  name: 'POST /appointments', fn: () => makeRequest('POST', '/api/v2/appointments', {
    patientId: randomUUID(), providerId: randomUUID(),
    appointmentDate: '2025-12-20T10:00:00Z', durationMinutes: 30, type: 'office-visit',
  })},
  { weight: 15, name: 'GET /claims', fn: () => makeRequest('GET', '/api/v2/claims?status=pending&limit=20') },
  { weight: 5,  name: 'POST /claims', fn: () => makeRequest('POST', '/api/v2/claims', generateClaimBody(randomUUID(), randomUUID())) },
  { weight: 10, name: 'GET /claims/:id/status', fn: () => makeRequest('GET', `/api/v2/claims/${randomUUID()}/status`) },
  { weight: 3,  name: 'POST /eligibility', fn: () => makeRequest('POST', '/api/v2/eligibility/check', {
    patientId: randomUUID(), payerId: 'BCBS001', dateOfService: '2025-12-15',
  })},
  { weight: 10, name: 'GET /providers', fn: () => makeRequest('GET', '/api/v2/providers?specialty=Family+Medicine&limit=20') },
];

function selectRandomRequest(): typeof REQUEST_GENERATORS[0] {
  const totalWeight = REQUEST_GENERATORS.reduce((sum, g) => sum + g.weight, 0);
  let r = Math.random() * totalWeight;
  for (const gen of REQUEST_GENERATORS) {
    r -= gen.weight;
    if (r <= 0) return gen;
  }
  return REQUEST_GENERATORS[0];
}

// -- Metrics Analysis --------------------------------------------------------

function analyzeMetrics(): void {
  // Group by endpoint
  const byEndpoint: Record<string, RequestMetrics[]> = {};
  for (const m of allMetrics) {
    if (!byEndpoint[m.endpoint]) byEndpoint[m.endpoint] = [];
    byEndpoint[m.endpoint].push(m);
  }

  console.log('');
  console.log('='.repeat(90));
  console.log('  RESULTS');
  console.log('='.repeat(90));
  console.log('');
  console.log(`${'Endpoint'.padEnd(42)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'Errors'.padStart(8)} ${'Count'.padStart(8)}`);
  console.log('-'.repeat(90));

  for (const [endpoint, metrics] of Object.entries(byEndpoint).sort()) {
    const durations = metrics.map(m => m.durationMs).sort((a, b) => a - b);
    const errorCount = metrics.filter(m => m.error || (m.statusCode >= 400)).length;
    const errorRate = (errorCount / metrics.length * 100).toFixed(2);

    const p50 = durations[Math.floor(durations.length * 0.5)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const p99 = durations[Math.floor(durations.length * 0.99)];

    const flag = p99 > 300 ? ' <--' : '';

    console.log(
      `${endpoint.padEnd(42)} ${(p50 + 'ms').padStart(8)} ${(p95 + 'ms').padStart(8)} ${(p99 + 'ms').padStart(8)} ${(errorRate + '%').padStart(8)} ${String(metrics.length).padStart(8)}${flag}`
    );
  }

  // Overall stats
  const totalRequests = allMetrics.length;
  const totalErrors = allMetrics.filter(m => m.error || m.statusCode >= 400).length;
  const allDurations = allMetrics.map(m => m.durationMs).sort((a, b) => a - b);

  console.log('');
  console.log('-'.repeat(90));
  console.log(`Total requests:  ${totalRequests}`);
  console.log(`Total errors:    ${totalErrors} (${(totalErrors / totalRequests * 100).toFixed(2)}%)`);
  console.log(`Overall p50:     ${allDurations[Math.floor(allDurations.length * 0.5)]}ms`);
  console.log(`Overall p95:     ${allDurations[Math.floor(allDurations.length * 0.95)]}ms`);
  console.log(`Overall p99:     ${allDurations[Math.floor(allDurations.length * 0.99)]}ms`);

  // Throughput over time (10-second buckets)
  const startTime = Math.min(...allMetrics.map(m => m.timestamp));
  const endTime = Math.max(...allMetrics.map(m => m.timestamp));
  const bucketSize = 10000; // 10 seconds

  console.log('');
  console.log('Throughput over time (req/s):');
  for (let t = startTime; t < endTime; t += bucketSize) {
    const bucketMetrics = allMetrics.filter(m => m.timestamp >= t && m.timestamp < t + bucketSize);
    const rps = (bucketMetrics.length / (bucketSize / 1000)).toFixed(1);
    const elapsed = ((t - startTime) / 1000).toFixed(0);
    const bar = '#'.repeat(Math.min(Math.floor(bucketMetrics.length / (bucketSize / 1000)), 80));
    console.log(`  ${elapsed.padStart(6)}s: ${rps.padStart(6)} rps ${bar}`);
  }
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Meridian API Load Test ===');
  console.log(`Target: ${targetEnv} (${baseUrl})`);
  console.log(`Scenario: ${scenario}`);
  console.log(`RPS: ${config.rps}`);
  console.log(`Duration: ${config.duration}s`);
  console.log(`Warmup: ${config.warmup}s`);
  console.log('');

  if (!authToken) {
    console.error('ERROR: LOAD_TEST_API_TOKEN environment variable is required');
    console.error('Get one from: https://admin.meridianhealth.io/api-tokens');
    process.exit(1);
  }

  if (targetEnv === 'production') {
    console.error('ERROR: Load testing against production is forbidden!');
    console.error('If you need to test production performance, use the observability dashboards.');
    process.exit(1);
  }

  // Warmup phase
  if (config.warmup > 0) {
    console.log(`Warming up (${config.warmup}s at ${Math.ceil(config.rps * 0.1)} rps)...`);
    const warmupEnd = Date.now() + config.warmup * 1000;
    const warmupInterval = 1000 / Math.ceil(config.rps * 0.1);

    while (Date.now() < warmupEnd) {
      const gen = selectRandomRequest();
      gen.fn();  // fire and forget during warmup
      await new Promise(r => setTimeout(r, warmupInterval));
    }

    // Clear warmup metrics
    allMetrics.length = 0;
    console.log('Warmup complete.\n');
  }

  // Main test
  console.log('Starting load test...');
  const testEnd = Date.now() + config.duration * 1000;
  const interval = 1000 / config.rps;

  let requestCount = 0;
  while (Date.now() < testEnd) {
    const gen = selectRandomRequest();
    gen.fn();  // fire and forget (async)
    requestCount++;

    if (requestCount % (config.rps * 10) === 0) {
      const elapsed = Math.floor((Date.now() - (testEnd - config.duration * 1000)) / 1000);
      const currentErrors = allMetrics.filter(m => m.error || m.statusCode >= 400).length;
      console.log(`  [${elapsed}s] Sent: ${requestCount}, Completed: ${allMetrics.length}, Errors: ${currentErrors}`);
    }

    await new Promise(r => setTimeout(r, interval));
  }

  // Wait for in-flight requests to complete
  console.log('\nWaiting for in-flight requests (10s)...');
  await new Promise(r => setTimeout(r, 10000));

  // Analyze results
  analyzeMetrics();
}

main().catch(console.error);
