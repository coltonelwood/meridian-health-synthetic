import { LRUCache } from 'lru-cache';
import { v4 as uuidv4 } from 'uuid';
import { AnalyticsEvent } from '../models/AnalyticsEvent';

const getLogger = () => (global as any).__logger;

/**
 * Session Stitcher
 *
 * Manages session state for analytics events. A "session" is a group of
 * events from the same user within a time window.
 *
 * Session rules:
 * - A new session starts when:
 *   a) No events from this user/anonymous_id for SESSION_TIMEOUT_MS (30 min)
 *   b) The user explicitly starts a new session (e.g., login)
 *   c) The day changes (sessions don't span midnight)
 * - Session IDs provided by the client are respected (we don't override them)
 * - When a user identifies (logs in), we associate their anonymous session
 *   with their user ID
 *
 * State is kept in an LRU cache because:
 * - We need fast lookups (event processing is latency-sensitive)
 * - We can afford to lose session state (it just means a new session starts)
 * - The cache self-manages memory (LRU eviction)
 *
 * Limitations:
 * - This only works when all events for a user hit the same process.
 * - With multiple replicas, a user's events might go to different
 *   processes and get different session IDs.
 * - The "right" fix is to use Redis for session state, but we haven't
 *   needed it yet because we only run 1-2 replicas.
 * - If we scale up, we'll need to either:
 *   a) Use sticky sessions (route by user_id hash)
 *   b) Move session state to Redis
 *   c) Do session stitching in ClickHouse (post-hoc)
 * Ticket: PLAT-8012
 */

const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || '1800000'); // 30 minutes

interface SessionState {
  session_id: string;
  user_id?: string;
  anonymous_id?: string;
  last_event_time: number;
  event_count: number;
  started_at: number;
  // Date when the session started (for midnight boundary)
  start_date: string;
}

// LRU cache for session state
// Max 100k sessions in memory (~50MB)
const sessionCache = new LRUCache<string, SessionState>({
  max: parseInt(process.env.SESSION_CACHE_SIZE || '100000'),
  ttl: SESSION_TIMEOUT_MS * 2, // TTL slightly longer than session timeout
  updateAgeOnGet: true,
});

// Separate cache for anonymous_id -> user_id mapping
// Used when a user identifies (logs in) to link their anonymous activity
const identityCache = new LRUCache<string, string>({
  max: 50000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

/**
 * Process an event through session stitching.
 * Returns session data including the session_id and event sequence number.
 */
export function stitchSession(event: AnalyticsEvent): {
  session_id: string;
  sequence: number;
} {
  // If client provided a session_id, use it
  if (event.session_id) {
    const cacheKey = getCacheKey(event);
    let session = sessionCache.get(cacheKey);

    if (session && session.session_id === event.session_id) {
      // Existing session
      session.event_count++;
      session.last_event_time = Date.now();
      sessionCache.set(cacheKey, session);
      return { session_id: session.session_id, sequence: session.event_count };
    } else {
      // New session with client-provided ID
      const newSession: SessionState = {
        session_id: event.session_id,
        user_id: event.user_id,
        anonymous_id: event.anonymous_id,
        last_event_time: Date.now(),
        event_count: 1,
        started_at: Date.now(),
        start_date: new Date().toISOString().split('T')[0],
      };
      sessionCache.set(cacheKey, newSession);
      return { session_id: event.session_id, sequence: 1 };
    }
  }

  // No client session_id - manage session server-side
  const cacheKey = getCacheKey(event);
  let session = sessionCache.get(cacheKey);
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  if (session) {
    const timeSinceLastEvent = now - session.last_event_time;
    const isNewDay = session.start_date !== today;

    if (timeSinceLastEvent > SESSION_TIMEOUT_MS || isNewDay) {
      // Session expired - start a new one
      session = createNewSession(event, now, today);
      sessionCache.set(cacheKey, session);
    } else {
      // Continue existing session
      session.event_count++;
      session.last_event_time = now;

      // Update user_id if this is an identify event
      if (event.user_id && !session.user_id) {
        session.user_id = event.user_id;
        // Also update identity mapping
        if (event.anonymous_id) {
          identityCache.set(event.anonymous_id, event.user_id);
        }
      }

      sessionCache.set(cacheKey, session);
    }
  } else {
    // New session
    session = createNewSession(event, now, today);

    // Check if we have an identity mapping for this anonymous user
    if (!event.user_id && event.anonymous_id) {
      const mappedUserId = identityCache.get(event.anonymous_id);
      if (mappedUserId) {
        session.user_id = mappedUserId;
        event.user_id = mappedUserId;
      }
    }

    sessionCache.set(cacheKey, session);
  }

  return {
    session_id: session.session_id,
    sequence: session.event_count,
  };
}

function createNewSession(event: AnalyticsEvent, now: number, today: string): SessionState {
  return {
    session_id: uuidv4(),
    user_id: event.user_id,
    anonymous_id: event.anonymous_id,
    last_event_time: now,
    event_count: 1,
    started_at: now,
    start_date: today,
  };
}

function getCacheKey(event: AnalyticsEvent): string {
  // Prefer user_id, fall back to anonymous_id
  // This means if a user logs in on two different devices, they'll
  // share session state. That's technically wrong (should be separate
  // sessions per device) but it simplifies things and for analytics
  // purposes it's close enough.
  return event.user_id || event.anonymous_id || `unknown-${event.ip_address || 'no-ip'}`;
}

/**
 * Get active session count (for monitoring)
 */
export function getActiveSessionCount(): number {
  return sessionCache.size;
}

/**
 * Clear session cache (for testing)
 */
export function clearSessionCache(): void {
  sessionCache.clear();
  identityCache.clear();
}
