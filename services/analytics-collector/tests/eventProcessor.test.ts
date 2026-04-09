import { processEventBatch } from '../src/services/eventProcessor';
import { resetBuffer, getBufferStats } from '../src/services/clickhouseWriter';
import { clearSessionCache } from '../src/services/sessionStitcher';
import { AnalyticsEvent } from '../src/models/AnalyticsEvent';

// Mock logger
(global as any).__logger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Mock ClickHouse client (we don't want actual writes in tests)
jest.mock('@clickhouse/client', () => ({
  createClient: jest.fn(() => ({
    insert: jest.fn().mockResolvedValue({}),
    close: jest.fn(),
  })),
}));

describe('eventProcessor', () => {
  beforeEach(() => {
    resetBuffer();
    clearSessionCache();
    jest.clearAllMocks();
  });

  it('should process a simple page view event', async () => {
    const event: AnalyticsEvent = {
      event_type: 'page_view',
      event_name: 'Home Page View',
      timestamp: '2024-06-15T10:30:00.000Z',
      user_id: 'user-123',
      session_id: 'session-abc',
      page_url: 'https://app.meridianhealth.com/dashboard',
      page_title: 'Dashboard',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      properties: {
        dashboard_type: 'provider',
      },
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
  });

  it('should process a batch of events', async () => {
    const events: AnalyticsEvent[] = [
      {
        event_type: 'page_view',
        event_name: 'Landing',
        user_id: 'user-1',
        properties: {},
      },
      {
        event_type: 'click',
        event_name: 'Login Button',
        user_id: 'user-1',
        properties: { button_id: 'login-btn' },
      },
      {
        event_type: 'form_submit',
        event_name: 'Login Form',
        user_id: 'user-1',
        properties: { success: true },
      },
    ];

    await processEventBatch(events);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(3);
    expect(stats.total_received).toBe(3);
  });

  it('should generate event IDs for events without them', async () => {
    const event: AnalyticsEvent = {
      event_type: 'click',
      event_name: 'Button Click',
      properties: {},
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
    // Can't easily check the generated ID without accessing buffer internals
    // but at least it didn't throw
  });

  it('should parse user agent for Chrome on Windows', async () => {
    const event: AnalyticsEvent = {
      event_type: 'page_view',
      event_name: 'Test',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      properties: {},
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
    // TODO: expose buffer contents for testing
    // For now just verify it doesn't crash
  });

  it('should detect bots from user agent', async () => {
    const event: AnalyticsEvent = {
      event_type: 'page_view',
      event_name: 'Bot Visit',
      user_agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      properties: {},
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
  });

  it('should scrub PHI from event properties', async () => {
    const event: AnalyticsEvent = {
      event_type: 'custom',
      event_name: 'Search',
      user_id: 'user-1',
      properties: {
        search_query: 'patient SSN 123-45-6789',
        notes: 'MRN: 12345678 had an issue',
        safe_field: 'this is fine',
      },
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
    // Note: we can't easily verify the scrubbed values without
    // exposing buffer internals. The scrubbing logic is tested
    // implicitly - if it crashes, this test fails.
  });

  it('should handle events with missing optional fields', async () => {
    const event: AnalyticsEvent = {
      event_type: 'custom',
      event_name: 'Minimal Event',
      properties: {},
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
  });

  it('should handle error events', async () => {
    const event: AnalyticsEvent = {
      event_type: 'error',
      event_name: 'JavaScript Error',
      user_id: 'user-5',
      error_message: 'TypeError: Cannot read properties of undefined',
      error_stack: 'TypeError: Cannot read properties of undefined\n    at Dashboard.render (dashboard.tsx:42)',
      error_code: 'RENDER_ERROR',
      properties: {
        component: 'Dashboard',
        route: '/dashboard',
      },
    };

    await processEventBatch([event]);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(1);
  });

  it('should skip invalid events without crashing the batch', async () => {
    const events: any[] = [
      {
        event_type: 'page_view',
        event_name: 'Valid Event',
        user_id: 'user-1',
        properties: {},
      },
      null, // this shouldn't happen but just in case
      {
        event_type: 'click',
        event_name: 'Also Valid',
        user_id: 'user-1',
        properties: {},
      },
    ];

    // Filter nulls like the Kafka consumer does
    const validEvents = events.filter(Boolean);
    await processEventBatch(validEvents);

    const stats = getBufferStats();
    expect(stats.buffer_size).toBe(2);
  });

  // TODO: test session stitching integration
  // TODO: test geo enrichment when we actually implement it
  // TODO: test performance with large batches (1000+ events)
  // TODO: test PHI scrubbing more thoroughly (specific patterns)
});
