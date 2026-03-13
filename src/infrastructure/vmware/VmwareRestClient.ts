/**
 * Thin HTTP wrapper for the VMware vSphere REST API.
 *
 * Automatically injects the session token and retries once
 * on 401 (Unauthorized) by re-authenticating.
 */

import { AxiosError } from 'axios';
import { VmwareAuthManager } from './VmwareAuthManager';
import { VmwareConnectionError } from '../../shared/errors';

export class VmwareRestClient {
  constructor(private readonly authManager: VmwareAuthManager) {}

  /**
   * Perform a GET request with automatic 401 retry.
   */
  async get<T>(path: string): Promise<T> {
    return this.requestWithRetry<T>('GET', path);
  }

  /**
   * Perform a POST request with automatic 401 retry.
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.requestWithRetry<T>('POST', path, body);
  }

  private async requestWithRetry<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<T> {
    try {
      return await this.executeRequest<T>(method, path, body);
    } catch (error) {
      if (this.isUnauthorized(error)) {
        this.authManager.invalidateToken();
        await this.authManager.authenticate();
        return this.executeRequest<T>(method, path, body);
      }
      throw this.wrapError(error, method, path);
    }
  }

  private async executeRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.authManager.getSessionToken();
    const client = this.authManager.getClient();
    const headers = { 'vmware-api-session-id': token };

    const response =
      method === 'GET'
        ? await client.get<T>(path, { headers })
        : await client.post<T>(path, body, { headers });

    return response.data;
  }

  private isUnauthorized(error: unknown): boolean {
    return error instanceof AxiosError && error.response?.status === 401;
  }

  private wrapError(error: unknown, method: string, path: string): Error {
    if (error instanceof VmwareConnectionError) {
      return error;
    }

    const message =
      error instanceof Error ? error.message : String(error);

    const statusCode =
      error instanceof AxiosError ? error.response?.status : undefined;

    return new VmwareConnectionError(
      `VMware API ${method} ${path} failed` +
        (statusCode ? ` (HTTP ${statusCode})` : '') +
        `: ${message}`,
      error instanceof Error ? error : undefined
    );
  }
}
