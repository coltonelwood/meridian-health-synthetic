import { z } from 'zod';

/**
 * Analytics event schema
 *
 * We use Zod for runtime validation because TypeScript types aren't
 * enough - we're ingesting events from multiple sources (web app,
 * mobile apps, backend services) and the data quality varies widely.
 *
 * Event types:
 * - page_view: user navigated to a page
 * - click: user clicked something
 * - form_submit: form was submitted
 * - api_call: backend API was called (from other services)
 * - error: an error occurred
 * - search: user performed a search
 * - feature_usage: a specific feature was used
 * - auth: authentication events (login, logout, etc.)
 * - clinical: clinical workflow events (PHI-free versions only!)
 * - performance: page load times, API response times
 * - custom: anything else
 */

export const AnalyticsEventSchema = z.object({
  // Event identity
  event_id: z.string().uuid().optional(), // we generate one if not provided
  event_type: z.enum([
    'page_view',
    'click',
    'form_submit',
    'api_call',
    'error',
    'search',
    'feature_usage',
    'auth',
    'clinical',
    'performance',
    'custom',
  ]),
  event_name: z.string().max(200),

  // Timing
  timestamp: z.string().datetime().optional(), // ISO 8601, defaults to now
  client_timestamp: z.string().datetime().optional(), // from the client clock
  // we noticed client clocks can be wildly wrong (sometimes years off)
  // so we always use server timestamp for analytics but keep client for debugging

  // User identification
  user_id: z.string().max(100).optional(), // our internal user ID
  anonymous_id: z.string().max(100).optional(), // for non-authenticated users
  session_id: z.string().max(100).optional(),

  // Context
  properties: z.record(z.unknown()).optional().default({}),

  // Page/screen info
  page_url: z.string().max(2000).optional(),
  page_title: z.string().max(500).optional(),
  referrer: z.string().max(2000).optional(),

  // Device/client info
  user_agent: z.string().max(1000).optional(),
  ip_address: z.string().max(45).optional(), // IPv6 can be long
  device_type: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).optional(),

  // App context
  app_version: z.string().max(50).optional(),
  app_name: z.string().max(100).optional(),
  environment: z.enum(['production', 'staging', 'development', 'test']).optional(),

  // Organization/tenant
  org_id: z.string().max(100).optional(),
  tenant_id: z.string().max(100).optional(),

  // Source service
  source: z.string().max(100).optional(),

  // Performance data
  duration_ms: z.number().optional(),
  // HTTP specific
  http_method: z.string().max(10).optional(),
  http_status: z.number().optional(),
  http_path: z.string().max(500).optional(),

  // Error data
  error_message: z.string().max(5000).optional(),
  error_stack: z.string().max(10000).optional(),
  error_code: z.string().max(100).optional(),
});

export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

// Batch event submission
export const EventBatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).min(1).max(1000),
  // Shared context applied to all events in the batch
  context: z.object({
    user_id: z.string().optional(),
    session_id: z.string().optional(),
    app_name: z.string().optional(),
    app_version: z.string().optional(),
    org_id: z.string().optional(),
  }).optional(),
});

export type EventBatch = z.infer<typeof EventBatchSchema>;

// What we store in ClickHouse (flattened, denormalized)
export interface ClickHouseEvent {
  event_id: string;
  event_type: string;
  event_name: string;
  timestamp: string; // ClickHouse DateTime64
  client_timestamp: string | null;
  user_id: string;
  anonymous_id: string;
  session_id: string;
  properties_json: string; // JSON string
  page_url: string;
  page_title: string;
  referrer: string;
  user_agent: string;
  ip_address: string;
  device_type: string;
  app_version: string;
  app_name: string;
  environment: string;
  org_id: string;
  tenant_id: string;
  source: string;
  duration_ms: number;
  http_method: string;
  http_status: number;
  http_path: string;
  error_message: string;
  error_code: string;
  // Enriched fields (added by eventProcessor)
  country: string;
  region: string;
  browser_name: string;
  browser_version: string;
  os_name: string;
  os_version: string;
  is_bot: number; // ClickHouse UInt8
  session_sequence: number; // event order within session
  // Partition key
  event_date: string; // Date for ClickHouse partitioning
}
