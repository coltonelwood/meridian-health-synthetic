import { FHIRResourceType } from '../models/ResourceMapping';

/**
 * FHIR Bundle Builder
 *
 * Builds FHIR Bundle resources for search results.
 * Bundles are the FHIR way of returning collections of resources.
 *
 * A searchset bundle includes:
 * - total count
 * - link (self, next, previous for pagination)
 * - entry array with fullUrl, resource, and search metadata
 *
 * We follow the FHIR spec pretty closely here but there are some
 * things we skip:
 * - We don't include _include/_revinclude resources
 * - We don't support _summary or _elements parameters
 * - Our pagination uses page numbers, not continuation tokens
 *   (FHIR recommends opaque continuation tokens but page numbers
 *   are simpler and work fine for our use case)
 */

interface BuildBundleParams {
  resourceType: FHIRResourceType;
  resources: any[];
  total: number;
  page: number;
  pageSize: number;
  baseUrl: string;
  searchParams: any;
}

export function buildSearchBundle(params: BuildBundleParams): any {
  const { resourceType, resources, total, page, pageSize, baseUrl, searchParams } = params;

  const totalPages = Math.ceil(total / pageSize);

  // Build search URL for self/next/prev links
  const searchUrl = buildSearchUrl(baseUrl, resourceType, searchParams);

  const bundle: any = {
    resourceType: 'Bundle',
    type: 'searchset',
    total,
    timestamp: new Date().toISOString(),
    link: buildPaginationLinks(searchUrl, page, totalPages, pageSize),
    entry: resources.map(resource => ({
      fullUrl: `${baseUrl}/${resource.resourceType || resourceType}/${resource.id}`,
      resource,
      search: {
        mode: 'match',
        // score is not meaningful for our searches but the spec allows it
        // score: 1.0,
      },
    })),
  };

  // Empty bundles should still have the structure but with empty entry
  if (resources.length === 0) {
    bundle.entry = [];
  }

  return bundle;
}

function buildPaginationLinks(searchUrl: string, page: number, totalPages: number, pageSize: number): any[] {
  const links: any[] = [];

  // Self link
  links.push({
    relation: 'self',
    url: `${searchUrl}&_page=${page}&_count=${pageSize}`,
  });

  // First link
  links.push({
    relation: 'first',
    url: `${searchUrl}&_page=1&_count=${pageSize}`,
  });

  // Previous link
  if (page > 1) {
    links.push({
      relation: 'previous',
      url: `${searchUrl}&_page=${page - 1}&_count=${pageSize}`,
    });
  }

  // Next link
  if (page < totalPages) {
    links.push({
      relation: 'next',
      url: `${searchUrl}&_page=${page + 1}&_count=${pageSize}`,
    });
  }

  // Last link
  if (totalPages > 0) {
    links.push({
      relation: 'last',
      url: `${searchUrl}&_page=${totalPages}&_count=${pageSize}`,
    });
  }

  return links;
}

function buildSearchUrl(baseUrl: string, resourceType: string, searchParams: any): string {
  const params = new URLSearchParams();

  // Add all search params except pagination ones (we add our own)
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === '_page' || key === '_count' || key === 'page' || key === 'page_size') continue;
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();
  return `${baseUrl}/${resourceType}${queryString ? '?' + queryString : '?'}`;
}

/**
 * Build a transaction bundle for batch operations.
 * Not fully implemented yet - we only use this for testing.
 */
export function buildTransactionBundle(entries: Array<{
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  resource?: any;
}>): any {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: entries.map(entry => ({
      resource: entry.resource,
      request: {
        method: entry.method,
        url: entry.url,
      },
    })),
  };
}

// TODO: implement batch/transaction bundle processing
// The FHIR spec supports submitting a Bundle with multiple operations
// that are processed atomically (transaction) or independently (batch).
// We don't support this yet but some EHR integrations need it.
// Ticket: PLAT-9123
