import { useCallback, useRef } from 'react';
import axios, { AxiosError } from 'axios';

// TODO: move to env config
const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

// Token refresh state - shared across all hook instances
// This is a module-level variable which is kind of gross but it works
let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = localStorage.getItem('meridian_refresh_token');
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const response = await axios.post(`${API_BASE}/auth/refresh`, {
    refreshToken,
  });

  const { accessToken, refreshToken: newRefreshToken } = response.data;
  localStorage.setItem('meridian_access_token', accessToken);
  if (newRefreshToken) {
    localStorage.setItem('meridian_refresh_token', newRefreshToken);
  }

  return accessToken;
}

function getAccessToken(): string | null {
  return localStorage.getItem('meridian_access_token');
}

/**
 * Custom hook for making authenticated API calls.
 *
 * Has built-in retry logic and token refresh. Probably should've just
 * used react-query's built-in auth handling but this was written before
 * we added react-query and nobody's refactored it yet.
 *
 * Known issues:
 * - Race condition: if two requests trigger a token refresh simultaneously,
 *   the second refresh can invalidate the first new token. We "fixed" this
 *   with the isRefreshing flag but it's not perfect.
 * - The retry logic retries on ALL errors, not just retryable ones.
 *   A 400 Bad Request will be retried which is dumb.
 */
export function useApi() {
  const retryCount = useRef(0);
  const MAX_RETRIES = 3;

  const fetchWithAuth = useCallback(async (
    url: string,
    options: RequestInit = {},
  ): Promise<any> => {
    let token = getAccessToken();

    // build full URL if relative
    const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;

    try {
      const response = await axios({
        url: fullUrl,
        method: (options.method as any) || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : '',
          ...(options.headers || {}),
        },
        data: options.body,
        // TODO: configurable timeout
        timeout: 30_000,
      });

      retryCount.current = 0;
      return response.data;

    } catch (error) {
      const axiosError = error as AxiosError;

      // 401 = token expired, try to refresh
      if (axiosError.response?.status === 401) {
        if (!isRefreshing) {
          isRefreshing = true;
          refreshPromise = refreshAccessToken().finally(() => {
            isRefreshing = false;
          });
        }

        try {
          token = await refreshPromise!;
          // retry original request with new token
          const retryResponse = await axios({
            url: fullUrl,
            method: (options.method as any) || 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
              ...(options.headers || {}),
            },
            data: options.body,
            timeout: 30_000,
          });
          return retryResponse.data;
        } catch (refreshError) {
          // refresh failed, send user to login
          localStorage.removeItem('meridian_access_token');
          localStorage.removeItem('meridian_refresh_token');
          // TODO: use react-router navigate instead of hard redirect
          window.location.href = '/login';
          throw refreshError;
        }
      }

      // Retry logic for other errors
      // BUG: this retries 400s which is wrong, should only retry 5xx and network errors
      // not fixing now because it technically "works" and I don't want to break anything
      if (retryCount.current < MAX_RETRIES) {
        retryCount.current++;
        // exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, retryCount.current - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithAuth(url, options);
      }

      retryCount.current = 0;
      throw error;
    }
  }, []);

  return { fetchWithAuth };
}
