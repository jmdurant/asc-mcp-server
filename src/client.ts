import { generateToken } from './auth.js';
import { AppStoreConnectError } from './errors.js';
import type { Config } from './config.js';

const BASE_URL = 'https://api.appstoreconnect.apple.com';

interface ApiErrorResponse {
  errors: Array<{
    status: string;
    code: string;
    title: string;
    detail: string;
  }>;
}

export class AppStoreConnectClient {
  constructor(private config: Config) {}

  async request<T>(path: string, options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  }): Promise<T> {
    const token = await generateToken(this.config);
    const method = options?.method ?? 'GET';

    let url = `${BASE_URL}${path}`;
    if (options?.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) searchParams.set(key, value);
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      let errorInfo: ApiErrorResponse | null = null;
      try {
        errorInfo = await response.json() as ApiErrorResponse;
      } catch {
        // response wasn't JSON
      }

      if (errorInfo?.errors?.[0]) {
        const e = errorInfo.errors[0];
        throw new AppStoreConnectError(
          parseInt(e.status, 10) || response.status,
          e.code,
          e.title,
          e.detail
        );
      }
      throw new AppStoreConnectError(
        response.status,
        'UNKNOWN',
        `HTTP ${response.status}`,
        await response.text().catch(() => 'No response body')
      );
    }

    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  async requestAll<T extends { data: unknown[]; links?: { next?: string } }>(
    path: string,
    params?: Record<string, string>,
    maxPages = 5
  ): Promise<T['data']> {
    const token = await generateToken(this.config);
    const allData: unknown[] = [];
    let url = `${BASE_URL}${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) searchParams.set(key, value);
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    for (let page = 0; page < maxPages; page++) {
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!response.ok) {
        let errorInfo: ApiErrorResponse | null = null;
        try { errorInfo = await response.json() as ApiErrorResponse; } catch {}
        if (errorInfo?.errors?.[0]) {
          const e = errorInfo.errors[0];
          throw new AppStoreConnectError(parseInt(e.status, 10) || response.status, e.code, e.title, e.detail);
        }
        throw new AppStoreConnectError(response.status, 'UNKNOWN', `HTTP ${response.status}`, '');
      }

      const json = await response.json() as T;
      allData.push(...json.data);

      if (!json.links?.next) break;
      url = json.links.next;
    }

    return allData as T['data'];
  }
}
