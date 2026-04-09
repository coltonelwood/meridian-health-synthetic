import { v4 as uuidv4 } from 'uuid';
import { AnalyticsEvent, ClickHouseEvent } from '../models/AnalyticsEvent';
import { addToBuffer } from './clickhouseWriter';
import { stitchSession } from './sessionStitcher';

const getLogger = () => (global as any).__logger;

/**
 * Event processing pipeline
 *
 * Takes raw events and transforms them into ClickHouse-ready rows.
 * The pipeline steps are:
 * 1. Validate & sanitize
 * 2. Parse user agent
 * 3. Geo-lookup (from IP)
 * 4. Session stitching
 * 5. PHI scrubbing (for clinical events)
 * 6. Buffer for batch write
 *
 * TODO: This is partially implemented as a pipeline pattern but not fully.
 * The original plan was to have each step be a separate function that could
 * be composed, with proper error handling and metrics at each step.
 * What we have now is basically a big function that does everything.
 * It works but it's not great for testing or monitoring individual steps.
 *
 * Future steps we want to add:
 * - Anomaly detection (spike in error events, etc.)
 * - Real-time aggregation (count events per type per minute)
 * - Event deduplication (we sometimes get duplicates from the mobile app)
 * - Rate limiting per org/user
 */

// Simple user agent parser
// We tried ua-parser-js but it was too slow for high-throughput event processing.
// This regex-based approach covers the main cases well enough for analytics.
interface ParsedUA {
  browser_name: string;
  browser_version: string;
  os_name: string;
  os_version: string;
  is_bot: boolean;
}

function parseUserAgent(ua?: string): ParsedUA {
  const result: ParsedUA = {
    browser_name: 'unknown',
    browser_version: '',
    os_name: 'unknown',
    os_version: '',
    is_bot: false,
  };

  if (!ua) return result;

  // Bot detection
  const botPatterns = /bot|crawl|spider|slurp|yahoo|bing|google|facebook|twitter|whatsapp|telegram|preview/i;
  result.is_bot = botPatterns.test(ua);

  // Browser detection (order matters - more specific first)
  if (ua.includes('Edg/')) {
    result.browser_name = 'Edge';
    result.browser_version = ua.match(/Edg\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Chrome/') && !ua.includes('Chromium/')) {
    result.browser_name = 'Chrome';
    result.browser_version = ua.match(/Chrome\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Firefox/')) {
    result.browser_name = 'Firefox';
    result.browser_version = ua.match(/Firefox\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome/')) {
    result.browser_name = 'Safari';
    result.browser_version = ua.match(/Version\/([\d.]+)/)?.[1] || '';
  } else if (ua.includes('MSIE') || ua.includes('Trident/')) {
    result.browser_name = 'IE';
    result.browser_version = ua.match(/(?:MSIE |rv:)([\d.]+)/)?.[1] || '';
  }

  // OS detection
  if (ua.includes('Windows NT')) {
    result.os_name = 'Windows';
    const ntVersion = ua.match(/Windows NT ([\d.]+)/)?.[1];
    // Map NT versions to consumer versions
    const versionMap: Record<string, string> = {
      '10.0': '10/11', // can't distinguish 10 from 11 in UA
      '6.3': '8.1',
      '6.2': '8',
      '6.1': '7',
    };
    result.os_version = versionMap[ntVersion || ''] || ntVersion || '';
  } else if (ua.includes('Mac OS X')) {
    result.os_name = 'macOS';
    result.os_version = ua.match(/Mac OS X ([\d._]+)/)?.[1]?.replace(/_/g, '.') || '';
  } else if (ua.includes('Android')) {
    result.os_name = 'Android';
    result.os_version = ua.match(/Android ([\d.]+)/)?.[1] || '';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    result.os_name = 'iOS';
    result.os_version = ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, '.') || '';
  } else if (ua.includes('Linux')) {
    result.os_name = 'Linux';
  }

  return result;
}

/**
 * Known PHI patterns that might appear in event properties.
 * We scrub these before writing to ClickHouse.
 *
 * IMPORTANT: This is a defense-in-depth measure. The frontend should
 * never send PHI in analytics events. But we've seen cases where
 * developers accidentally include patient names or MRNs in custom
 * event properties. This scrubber catches the obvious cases.
 */
const PHI_PATTERNS = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN_REDACTED]' },
  { pattern: /\b\d{9}\b/g, replacement: '[POSSIBLE_SSN_REDACTED]' }, // too aggressive? maybe
  { pattern: /\bMRN[:\s]*\d{6,10}\b/gi, replacement: '[MRN_REDACTED]' },
  // Date of birth patterns
  { pattern: /\b(DOB|date.?of.?birth)[:\s]*\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b/gi, replacement: '[DOB_REDACTED]' },
  // Email-like patterns in clinical contexts
  // Actually, let's not scrub emails - they're needed for user identification
  // { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL_REDACTED]' },
];

function scrubPHI(value: string): string {
  let scrubbed = value;
  for (const { pattern, replacement } of PHI_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

function scrubProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') {
      scrubbed[key] = scrubPHI(value);
    } else if (typeof value === 'object' && value !== null) {
      scrubbed[key] = scrubProperties(value as Record<string, unknown>);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

/**
 * Process a batch of events through the pipeline.
 */
export async function processEventBatch(events: AnalyticsEvent[]): Promise<void> {
  const logger = getLogger();
  const startTime = Date.now();

  const clickhouseEvents: ClickHouseEvent[] = [];

  for (const event of events) {
    try {
      // Step 1: Ensure required fields
      if (!event.event_id) {
        event.event_id = uuidv4();
      }
      if (!event.timestamp) {
        event.timestamp = new Date().toISOString();
      }

      // Step 2: Parse user agent
      const ua = parseUserAgent(event.user_agent);

      // Step 3: Geo lookup from IP
      // TODO: implement actual geo lookup using MaxMind GeoIP2
      // For now we just leave country/region empty
      // We had a MaxMind license but it expired and nobody renewed it
      const geo = { country: '', region: '' };

      // Step 4: Session stitching
      const sessionData = stitchSession(event);

      // Step 5: PHI scrubbing
      const scrubbedProperties = event.properties
        ? scrubProperties(event.properties)
        : {};

      // Also scrub specific fields
      const scrubbedPageUrl = event.page_url ? scrubPHI(event.page_url) : '';
      const scrubbedPageTitle = event.page_title ? scrubPHI(event.page_title) : '';

      // Step 6: Transform to ClickHouse format
      const chEvent: ClickHouseEvent = {
        event_id: event.event_id!,
        event_type: event.event_type,
        event_name: event.event_name,
        timestamp: event.timestamp!,
        client_timestamp: event.client_timestamp || null,
        user_id: event.user_id || '',
        anonymous_id: event.anonymous_id || '',
        session_id: event.session_id || sessionData.session_id,
        properties_json: JSON.stringify(scrubbedProperties),
        page_url: scrubbedPageUrl,
        page_title: scrubbedPageTitle,
        referrer: event.referrer || '',
        user_agent: event.user_agent || '',
        ip_address: event.ip_address || '',
        device_type: event.device_type || detectDeviceType(event.user_agent),
        app_version: event.app_version || '',
        app_name: event.app_name || '',
        environment: event.environment || 'production',
        org_id: event.org_id || '',
        tenant_id: event.tenant_id || '',
        source: event.source || '',
        duration_ms: event.duration_ms || 0,
        http_method: event.http_method || '',
        http_status: event.http_status || 0,
        http_path: event.http_path || '',
        error_message: event.error_message ? scrubPHI(event.error_message) : '',
        error_code: event.error_code || '',
        // Enriched fields
        country: geo.country,
        region: geo.region,
        browser_name: ua.browser_name,
        browser_version: ua.browser_version,
        os_name: ua.os_name,
        os_version: ua.os_version,
        is_bot: ua.is_bot ? 1 : 0,
        session_sequence: sessionData.sequence,
        // Partition key
        event_date: event.timestamp!.split('T')[0],
      };

      clickhouseEvents.push(chEvent);
    } catch (err: any) {
      logger.warn('Failed to process event', {
        eventId: event.event_id,
        error: err.message,
      });
      // Skip this event, continue with others
    }
  }

  // Add to write buffer
  if (clickhouseEvents.length > 0) {
    addToBuffer(clickhouseEvents);
  }

  const processingTime = Date.now() - startTime;
  if (processingTime > 100) {
    logger.warn('Slow event batch processing', {
      eventCount: events.length,
      processingMs: processingTime,
    });
  }
}

function detectDeviceType(userAgent?: string): string {
  if (!userAgent) return 'unknown';
  if (/tablet|ipad/i.test(userAgent)) return 'tablet';
  if (/mobile|iphone|android(?!.*tablet)/i.test(userAgent)) return 'mobile';
  return 'desktop';
}
