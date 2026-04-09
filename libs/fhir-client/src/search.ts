/**
 * FHIR Search Parameter Builder
 *
 * Provides a fluent API for constructing FHIR search queries.
 * Supports standard FHIR search features:
 * - Chained parameters (e.g., patient.name)
 * - _include and _revinclude for eager loading related resources
 * - Modifiers (exact, contains, missing, etc.)
 * - Composite parameters
 * - Sorting
 * - Pagination
 *
 * Usage:
 * ```
 * const results = await client.searchBuilder('Patient')
 *   .where('name', 'Smith')
 *   .where('birthdate', 'gt1990-01-01')
 *   .include('Patient', 'generalPractitioner')
 *   .sort('name')
 *   .count(20)
 *   .execute();
 * ```
 */

import { FHIRResource, FHIRBundle, FHIRSearchParams } from './types';

// Forward declaration - the actual FHIRClient type is defined in index.ts
interface FHIRClientLike {
  search<T extends FHIRResource>(resourceType: string, params: FHIRSearchParams): Promise<FHIRBundle<T>>;
}

export class FHIRSearchBuilder {
  private client: FHIRClientLike;
  private resourceType: string;
  private params: Map<string, string | string[]>;

  constructor(client: FHIRClientLike, resourceType: string) {
    this.client = client;
    this.resourceType = resourceType;
    this.params = new Map();
  }

  /**
   * Add a search parameter.
   * Supports FHIR prefix modifiers for date/number comparisons:
   * eq, ne, lt, gt, ge, le, sa, eb, ap
   *
   * Examples:
   * - where('name', 'Smith')
   * - where('birthdate', 'gt1990-01-01')
   * - where('status', 'active')
   */
  where(param: string, value: string | number | boolean): FHIRSearchBuilder {
    this.params.set(param, String(value));
    return this;
  }

  /**
   * Add a parameter with a modifier.
   * Examples:
   * - whereModifier('name', 'exact', 'Smith') -> name:exact=Smith
   * - whereModifier('name', 'contains', 'Smi') -> name:contains=Smi
   * - whereModifier('email', 'missing', true) -> email:missing=true
   */
  whereModifier(
    param: string,
    modifier: 'exact' | 'contains' | 'missing' | 'text' | 'not' | 'above' | 'below' | 'in' | 'not-in',
    value: string | boolean
  ): FHIRSearchBuilder {
    this.params.set(`${param}:${modifier}`, String(value));
    return this;
  }

  /**
   * Search with a token parameter (system|code format).
   * Used for coded values like identifiers, status, etc.
   *
   * Examples:
   * - whereToken('identifier', 'http://meridianhealth.io/mrn', 'MH-XXXXXXXXXX')
   * - whereToken('code', 'http://loinc.org', '8867-4')
   */
  whereToken(param: string, system: string, code: string): FHIRSearchBuilder {
    this.params.set(param, `${system}|${code}`);
    return this;
  }

  /**
   * Add a chained search parameter.
   * Example: patient.name -> searches through the patient reference
   */
  whereChained(path: string, value: string): FHIRSearchBuilder {
    this.params.set(path, value);
    return this;
  }

  /**
   * Include related resources in the result.
   * _include: forward references (e.g., Patient -> Organization)
   *
   * Example:
   * include('Patient', 'generalPractitioner') -> _include=Patient:generalPractitioner
   */
  include(resourceType: string, searchParam: string): FHIRSearchBuilder {
    const existing = this.params.get('_include');
    const value = `${resourceType}:${searchParam}`;

    if (existing) {
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        this.params.set('_include', [existing, value]);
      }
    } else {
      this.params.set('_include', value);
    }

    return this;
  }

  /**
   * Reverse include related resources.
   * _revinclude: reverse references (e.g., get Conditions that reference a Patient)
   *
   * Example:
   * revInclude('Condition', 'patient') -> _revinclude=Condition:patient
   */
  revInclude(resourceType: string, searchParam: string): FHIRSearchBuilder {
    const existing = this.params.get('_revinclude');
    const value = `${resourceType}:${searchParam}`;

    if (existing) {
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        this.params.set('_revinclude', [existing, value]);
      }
    } else {
      this.params.set('_revinclude', value);
    }

    return this;
  }

  /**
   * Sort results.
   * Prefix with '-' for descending order.
   *
   * Examples:
   * - sort('name') -> ascending by name
   * - sort('-date') -> descending by date
   */
  sort(field: string): FHIRSearchBuilder {
    this.params.set('_sort', field);
    return this;
  }

  /**
   * Set the page size.
   */
  count(count: number): FHIRSearchBuilder {
    this.params.set('_count', String(count));
    return this;
  }

  /**
   * Set the result offset (for offset-based pagination).
   */
  offset(offset: number): FHIRSearchBuilder {
    this.params.set('_offset', String(offset));
    return this;
  }

  /**
   * Request total count in the Bundle.
   * Note: This can be expensive on the server side.
   */
  total(mode: 'none' | 'estimate' | 'accurate' = 'estimate'): FHIRSearchBuilder {
    this.params.set('_total', mode);
    return this;
  }

  /**
   * Select specific elements to return (reduce payload size).
   */
  elements(...fields: string[]): FHIRSearchBuilder {
    this.params.set('_elements', fields.join(','));
    return this;
  }

  /**
   * Return only the count, not the resources.
   */
  summary(mode: 'true' | 'text' | 'data' | 'count'): FHIRSearchBuilder {
    this.params.set('_summary', mode);
    return this;
  }

  /**
   * Execute the search query.
   */
  async execute<T extends FHIRResource>(): Promise<FHIRBundle<T>> {
    const params: FHIRSearchParams = {};
    for (const [key, value] of this.params) {
      params[key] = value;
    }
    return this.client.search<T>(this.resourceType, params);
  }

  /**
   * Build the search params without executing.
   * Useful for debugging or passing to other methods.
   */
  build(): FHIRSearchParams {
    const params: FHIRSearchParams = {};
    for (const [key, value] of this.params) {
      params[key] = value;
    }
    return params;
  }
}
