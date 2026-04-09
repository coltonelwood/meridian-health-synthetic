import axios from 'axios';

const API_BASE = process.env.REACT_APP_AUDIT_API_URL || 'http://localhost:3003';

// in-memory cache for search results
// WARNING: This cache can show stale data! If someone performs an action
// that creates a new audit entry, the cached search results won't include it
// until the cache expires. The TTL is 30 seconds which seems reasonable
// for audit logs (they don't change retroactively) but new entries won't
// show up immediately.
//
// The compliance team noticed this during a live audit review and thought
// entries were missing. They weren't - just cached. Added a "refresh" button
// as a workaround but the real fix is to bust the cache on new searches.
// TODO: just remove the caching, it causes more problems than it solves

interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: any): void {
  // don't let cache grow unbounded
  if (cache.size > 100) {
    // delete oldest entries
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 50; i++) {
      cache.delete(entries[i][0]);
    }
  }
  cache.set(key, { data, timestamp: Date.now() });
}

// --- Types ---

export interface AuditEntry {
  id: string;
  timestamp: string;
  userId: string;
  userName?: string;
  userRole?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ipAddress?: string;
  sessionId?: string;
  userAgent?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  details?: string | Record<string, any>;
}

interface SearchParams {
  userId?: string;
  patientId?: string;
  action?: string;
  startDate: string;
  endDate: string;
  ipAddress?: string;
  resourceType?: string;
  page: number;
  limit: number;
}

interface SearchResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
}

// --- API functions ---

export async function searchAuditLogs(params: SearchParams): Promise<SearchResponse> {
  const cacheKey = JSON.stringify(params);
  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  const queryParams = new URLSearchParams();
  if (params.userId) queryParams.set('userId', params.userId);
  if (params.patientId) queryParams.set('resourceId', params.patientId);
  if (params.action) queryParams.set('action', params.action);
  queryParams.set('startDate', params.startDate);
  queryParams.set('endDate', params.endDate);
  if (params.ipAddress) queryParams.set('ipAddress', params.ipAddress);
  if (params.resourceType) queryParams.set('resourceType', params.resourceType);
  queryParams.set('page', String(params.page));
  queryParams.set('limit', String(params.limit));

  try {
    const response = await axios.get(`${API_BASE}/api/audit/search?${queryParams}`, {
      headers: {
        // TODO: use proper auth token from context
        'Authorization': `Bearer ${getStoredToken()}`,
      },
      timeout: 30_000,
    });

    const result: SearchResponse = {
      entries: response.data.entries || [],
      total: response.data.total || 0,
      page: response.data.page || params.page,
    };

    setCache(cacheKey, result);
    return result;
  } catch (err: any) {
    if (err.response?.status === 401) {
      // TODO: handle auth properly
      window.location.href = '/login';
    }
    throw new Error(err.response?.data?.error || err.message || 'Search failed');
  }
}

export async function getAuditEntry(id: string): Promise<{ entry: AuditEntry; related: AuditEntry[] }> {
  const cacheKey = `entry:${id}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${API_BASE}/api/audit/entries/${id}`, {
      headers: {
        'Authorization': `Bearer ${getStoredToken()}`,
      },
      timeout: 15_000,
    });

    const result = {
      entry: response.data.entry,
      related: response.data.related || [],
    };

    setCache(cacheKey, result);
    return result;
  } catch (err: any) {
    if (err.response?.status === 404) {
      throw new Error('Audit entry not found');
    }
    throw new Error(err.response?.data?.error || err.message || 'Failed to load entry');
  }
}

/**
 * Get all audit entries for a specific patient (for the timeline view).
 * This can return a LOT of data for active patients, so we limit to
 * the most recent 200 entries.
 *
 * TODO: add pagination to this endpoint
 */
export async function getPatientTimeline(patientId: string): Promise<AuditEntry[]> {
  const cacheKey = `timeline:${patientId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(
      `${API_BASE}/api/audit/timeline/${patientId}?limit=200`,
      {
        headers: {
          'Authorization': `Bearer ${getStoredToken()}`,
        },
        timeout: 30_000,
      }
    );

    const entries = response.data.entries || [];
    setCache(cacheKey, entries);
    return entries;
  } catch (err: any) {
    throw new Error(err.response?.data?.error || 'Failed to load timeline');
  }
}

// token helper - same lazy approach as the admin dashboard
function getStoredToken(): string {
  return localStorage.getItem('meridian_access_token') || '';
}
