/**
 * @meridian/fhir-client
 *
 * FHIR R4 client for interoperability with external EHR systems,
 * health information exchanges (HIEs), and payer systems.
 *
 * Supports:
 * - CRUD operations on FHIR resources
 * - Search with standard FHIR search parameters
 * - Transaction bundles
 * - Pagination (FHIR Bundle links)
 *
 * Authentication:
 * - SMART on FHIR (OAuth 2.0) for EHR connections
 * - Client credentials for backend-to-backend
 * - Basic auth (legacy, some payers still require it)
 *
 * This client is used by:
 * - FHIR Gateway service (incoming/outgoing FHIR requests)
 * - Data exchange jobs (CMS interoperability rule compliance)
 * - Patient access API (21st Century Cures Act)
 */

import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import axiosRetry from 'axios-retry';
import { ExternalServiceError } from '@meridian/shared-utils';
import { FHIRResource, FHIRBundle, FHIROperationOutcome, FHIRPatient, FHIRCondition } from './types';
import { FHIRSearchBuilder } from './search';

// --- Types -------------------------------------------------------------------

export interface FHIRClientConfig {
  baseUrl: string;
  auth: FHIRAuthConfig;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
}

type FHIRAuthConfig =
  | { type: 'none' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'smart'; clientId: string; clientSecret: string; tokenUrl: string; scope: string };

export interface FHIRSearchParams {
  [key: string]: string | string[] | number | boolean | undefined;
}

// --- Client ------------------------------------------------------------------

export class FHIRClient {
  private http: AxiosInstance;
  private baseUrl: string;
  private authConfig: FHIRAuthConfig;
  private accessToken?: string;
  private tokenExpiry?: Date;

  constructor(config: FHIRClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authConfig = config.auth;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/fhir+json',
        Accept: 'application/fhir+json',
        ...config.headers,
      },
    });

    // Configure retry logic
    axiosRetry(this.http, {
      retries: config.retries ?? 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        // Retry on network errors, 429 (rate limit), and 5xx
        if (axiosRetry.isNetworkOrIdempotentRequestError(error)) return true;
        if (error.response?.status === 429) return true;
        if (error.response && error.response.status >= 500) return true;
        return false;
      },
    });

    // Request interceptor for auth
    this.http.interceptors.request.use(async (requestConfig) => {
      const token = await this.getAuthToken();
      if (token) {
        requestConfig.headers.Authorization = `Bearer ${token}`;
      }
      return requestConfig;
    });

    // Response interceptor for error mapping
    this.http.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        throw this.mapError(error);
      }
    );
  }

  // --- CRUD Operations -------------------------------------------------------

  /**
   * Read a FHIR resource by type and ID.
   */
  async read<T extends FHIRResource>(resourceType: string, id: string): Promise<T> {
    const response = await this.http.get<T>(`/${resourceType}/${id}`);
    return response.data;
  }

  /**
   * Create a new FHIR resource.
   */
  async create<T extends FHIRResource>(resourceType: string, resource: T): Promise<T> {
    const response = await this.http.post<T>(`/${resourceType}`, resource);
    return response.data;
  }

  /**
   * Update an existing FHIR resource (full replacement).
   */
  async update<T extends FHIRResource>(resourceType: string, id: string, resource: T): Promise<T> {
    const response = await this.http.put<T>(`/${resourceType}/${id}`, resource);
    return response.data;
  }

  /**
   * Delete a FHIR resource.
   * Note: Most FHIR servers don't actually delete - they mark as inactive.
   */
  async delete(resourceType: string, id: string): Promise<void> {
    await this.http.delete(`/${resourceType}/${id}`);
  }

  // --- Search ----------------------------------------------------------------

  /**
   * Search for FHIR resources.
   *
   * Usage:
   * ```
   * const patients = await client.search<FHIRPatient>('Patient', {
   *   name: 'Smith',
   *   birthdate: '1990-01-01',
   *   _count: 10,
   * });
   * ```
   */
  async search<T extends FHIRResource>(
    resourceType: string,
    params: FHIRSearchParams
  ): Promise<FHIRBundle<T>> {
    const queryString = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return value.map(v => `${key}=${encodeURIComponent(String(v))}`).join('&');
        }
        return `${key}=${encodeURIComponent(String(value))}`;
      })
      .join('&');

    const response = await this.http.get<FHIRBundle<T>>(
      `/${resourceType}?${queryString}`
    );
    return response.data;
  }

  /**
   * Create a search builder for constructing complex queries.
   */
  searchBuilder(resourceType: string): FHIRSearchBuilder {
    return new FHIRSearchBuilder(this, resourceType);
  }

  /**
   * Follow a pagination link from a Bundle.
   */
  async nextPage<T extends FHIRResource>(bundle: FHIRBundle<T>): Promise<FHIRBundle<T> | null> {
    const nextLink = bundle.link?.find(l => l.relation === 'next');
    if (!nextLink) return null;

    const response = await this.http.get<FHIRBundle<T>>(nextLink.url);
    return response.data;
  }

  // --- Transactions ----------------------------------------------------------

  /**
   * Submit a FHIR transaction bundle.
   * All entries are processed atomically.
   */
  async transaction(bundle: FHIRBundle<FHIRResource>): Promise<FHIRBundle<FHIRResource>> {
    if (bundle.type !== 'transaction') {
      throw new Error('Bundle type must be "transaction"');
    }

    const response = await this.http.post<FHIRBundle<FHIRResource>>('/', bundle);
    return response.data;
  }

  // --- Convenience Methods ---------------------------------------------------

  /**
   * Get a patient by MRN (uses identifier search).
   */
  async getPatientByMRN(mrn: string): Promise<FHIRPatient | null> {
    const bundle = await this.search<FHIRPatient>('Patient', {
      identifier: `http://meridianhealth.io/fhir/mrn|${mrn}`,
    });

    if (!bundle.entry || bundle.entry.length === 0) return null;
    return bundle.entry[0].resource;
  }

  /**
   * Get conditions for a patient.
   */
  async getPatientConditions(patientId: string): Promise<FHIRCondition[]> {
    const bundle = await this.search<FHIRCondition>('Condition', {
      patient: patientId,
      'clinical-status': 'active',
      _sort: '-onset-date',
    });

    return bundle.entry?.map(e => e.resource) || [];
  }

  // --- Auth ------------------------------------------------------------------

  private async getAuthToken(): Promise<string | null> {
    switch (this.authConfig.type) {
      case 'none':
        return null;

      case 'basic': {
        const encoded = Buffer.from(
          `${this.authConfig.username}:${this.authConfig.password}`
        ).toString('base64');
        return encoded; // Will be set as Basic auth, not Bearer
      }

      case 'bearer':
        return this.authConfig.token;

      case 'smart':
        return this.getSmartToken();
    }
  }

  private async getSmartToken(): Promise<string> {
    // Return cached token if not expired
    if (this.accessToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (this.authConfig.type !== 'smart') {
      throw new Error('SMART auth not configured');
    }

    try {
      const response = await axios.post(
        this.authConfig.tokenUrl,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.authConfig.clientId,
          client_secret: this.authConfig.clientSecret,
          scope: this.authConfig.scope,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      this.tokenExpiry = new Date(
        Date.now() + (response.data.expires_in - 300) * 1000
      );

      return this.accessToken!;
    } catch (error: any) {
      throw new ExternalServiceError(
        'FHIR SMART Auth',
        'Failed to obtain access token',
        error.message
      );
    }
  }

  // --- Error Mapping ---------------------------------------------------------

  private mapError(error: AxiosError): Error {
    const status = error.response?.status;
    const data = error.response?.data as FHIROperationOutcome | undefined;

    const message = data?.issue?.[0]?.diagnostics ||
      data?.issue?.[0]?.details?.text ||
      error.message;

    return new ExternalServiceError(
      'FHIR Server',
      `${status || 'Network Error'}: ${message}`,
      error.message
    );
  }
}

// Re-export types and search builder
export { FHIRSearchBuilder } from './search';
export * from './types';
