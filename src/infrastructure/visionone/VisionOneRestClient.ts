/**
 * HTTP client for the Trend Micro Vision One API.
 *
 * Handles authentication via Bearer token, regional base URL
 * resolution, and automatic retry on 429 (rate limiting).
 */

import axios, { AxiosError, AxiosInstance } from 'axios';
import { VisionOneApiError } from '../../shared/errors';

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;

export class VisionOneRestClient {
  private client: AxiosInstance;
  private readonly rateLimitDelayMs: number;

  constructor(
    private readonly apiToken: string,
    private readonly region: string,
    private readonly requestTimeoutMs: number = 30000,
    rateLimitDelayMs: number = DEFAULT_RATE_LIMIT_DELAY_MS
  ) {
    const baseURL = this.resolveBaseUrl(region);
    this.rateLimitDelayMs = rateLimitDelayMs;

    this.client = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: requestTimeoutMs,
    });
  }

  async get<T>(
    path: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    return this.withRateLimitRetry(async () => {
      const response = await this.client.get<T>(path, { params });
      return response.data;
    }, 'GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.withRateLimitRetry(async () => {
      const response = await this.client.post<T>(path, body);
      return response.data;
    }, 'POST', path);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.withRateLimitRetry(async () => {
      const response = await this.client.patch<T>(path, body);
      return response.data;
    }, 'PATCH', path);
  }

  async delete(path: string): Promise<void> {
    return this.withRateLimitRetry(async () => {
      await this.client.delete(path);
    }, 'DELETE', path);
  }

  /**
   * Retry a request when Vision One responds with 429 Too Many Requests.
   * Uses the Retry-After header if present, otherwise falls back to
   * the configured delay.
   */
  private async withRateLimitRetry<T>(
    fn: () => Promise<T>,
    method: string,
    path: string
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (!this.isRateLimited(error) || attempt === MAX_RATE_LIMIT_RETRIES) {
          break;
        }

        const delayMs = this.extractRetryAfterMs(error) ?? this.rateLimitDelayMs;
        await this.sleep(delayMs);
      }
    }

    throw this.wrapError(lastError, method, path);
  }

  private isRateLimited(error: unknown): boolean {
    return error instanceof AxiosError && error.response?.status === 429;
  }

  private extractRetryAfterMs(error: unknown): number | null {
    if (!(error instanceof AxiosError)) {
      return null;
    }

    const retryAfter = error.response?.headers?.['retry-after'];
    if (!retryAfter) {
      return null;
    }

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }

    return null;
  }

  private wrapError(error: unknown, method: string, path: string): Error {
    if (error instanceof VisionOneApiError) {
      return error;
    }

    const statusCode =
      error instanceof AxiosError ? error.response?.status : undefined;

    const message =
      error instanceof Error ? error.message : String(error);

    return new VisionOneApiError(
      `Vision One API ${method} ${path} failed` +
        (statusCode ? ` (HTTP ${statusCode})` : '') +
        `: ${message}`,
      statusCode,
      error instanceof Error ? error : undefined
    );
  }

  private resolveBaseUrl(region: string): string {
    if (region === 'jp') {
      return 'https://api.xdr.trendmicro.co.jp';
    }
    return `https://api.${region}.xdr.trendmicro.com`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
