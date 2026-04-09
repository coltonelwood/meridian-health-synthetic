/**
 * Pagination utilities.
 *
 * We support two pagination styles:
 * 1. Cursor-based (preferred for real-time data, patient lists)
 * 2. Offset-based (used for reports, admin interfaces)
 *
 * TODO: Standardize all services on cursor-based pagination.
 * Currently, patient-api and referral-service use cursor-based,
 * but claims-engine and scheduling-service still use offset-based.
 * The plan was to migrate everything by Q4 2025 but it keeps slipping.
 * Ticket: MH-2981
 */

// --- Types -------------------------------------------------------------------

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface CursorPaginationParams {
  cursor?: string;
  limit: number;
  direction?: 'forward' | 'backward';
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
  totalCount?: number; // Optional - computing total count is expensive
  currentPage?: number;
  totalPages?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pageInfo: PageInfo;
}

// --- Cursor Encoding/Decoding ------------------------------------------------

/**
 * Encode a cursor value. We use base64 encoding of a JSON object
 * containing the sort field value and the record ID.
 *
 * Format: { id: string, sortValue: any, sortField: string }
 */
export function encodeCursor(id: string, sortValue: any, sortField: string = 'id'): string {
  const payload = JSON.stringify({ id, v: sortValue, f: sortField });
  return Buffer.from(payload).toString('base64url');
}

/**
 * Decode a cursor string back to its component values.
 */
export function decodeCursor(cursor: string): { id: string; sortValue: any; sortField: string } | null {
  try {
    const payload = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(payload);
    return {
      id: parsed.id,
      sortValue: parsed.v,
      sortField: parsed.f || 'id',
    };
  } catch {
    return null;
  }
}

// --- Cursor-based Pagination -------------------------------------------------

/**
 * Apply cursor-based pagination to a result set.
 *
 * Usage:
 * ```
 * const results = await db.query(`
 *   SELECT * FROM patients
 *   WHERE id > $1
 *   ORDER BY id ASC
 *   LIMIT $2
 * `, [decodeCursor(params.cursor)?.id || '', params.limit + 1]);
 *
 * return cursorPaginate(results, params, (item) => encodeCursor(item.id, item.id));
 * ```
 */
export function cursorPaginate<T>(
  items: T[],
  params: CursorPaginationParams,
  getCursor: (item: T) => string
): PaginatedResult<T> {
  const { limit, cursor } = params;

  // We fetch limit + 1 to determine if there's a next page
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;

  return {
    data: pageItems,
    pageInfo: {
      hasNextPage: hasMore,
      hasPreviousPage: !!cursor,
      startCursor: pageItems.length > 0 ? getCursor(pageItems[0]) : undefined,
      endCursor: pageItems.length > 0 ? getCursor(pageItems[pageItems.length - 1]) : undefined,
    },
  };
}

// --- Offset-based Pagination -------------------------------------------------

/**
 * Create page info for offset-based pagination.
 */
export function createPageInfo(
  totalCount: number,
  page: number,
  pageSize: number
): PageInfo {
  const totalPages = Math.ceil(totalCount / pageSize);

  return {
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
    totalCount,
    currentPage: page,
    totalPages,
  };
}

/**
 * Apply offset-based pagination to a result set.
 *
 * Usage:
 * ```
 * const { page, pageSize } = params;
 * const offset = (page - 1) * pageSize;
 * const items = await db.query('SELECT * FROM claims LIMIT $1 OFFSET $2', [pageSize, offset]);
 * const total = await db.query('SELECT COUNT(*) FROM claims');
 * return paginate(items, total.rows[0].count, { page, pageSize });
 * ```
 */
export function paginate<T>(
  items: T[],
  totalCount: number,
  params: PaginationParams
): PaginatedResult<T> {
  return {
    data: items,
    pageInfo: createPageInfo(totalCount, params.page, params.pageSize),
  };
}
