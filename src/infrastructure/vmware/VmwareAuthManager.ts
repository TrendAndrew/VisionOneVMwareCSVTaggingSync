/**
 * VMware vSphere session lifecycle manager.
 *
 * Handles authentication via POST /api/session with Basic auth,
 * caches the session token, re-authenticates on 401, and
 * cleans up with DELETE /api/session on disconnect.
 */

import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { VmwareConnectionError } from '../../shared/errors';

export class VmwareAuthManager {
  private sessionToken: string | null = null;
  private client: AxiosInstance;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly verifySsl: boolean
  ) {
    this.client = axios.create({
      baseURL: `https://${host}`,
      httpsAgent: new https.Agent({ rejectUnauthorized: verifySsl }),
      timeout: 30000,
    });
  }

  /**
   * Authenticate with vCenter and cache the session token.
   * Throws VmwareConnectionError on failure.
   */
  async authenticate(): Promise<void> {
    try {
      const response = await this.client.post<string>(
        '/api/session',
        null,
        {
          auth: {
            username: this.username,
            password: this.password,
          },
        }
      );

      const token = response.data;
      if (!token || typeof token !== 'string') {
        throw new VmwareConnectionError(
          'vCenter returned an empty or invalid session token'
        );
      }

      this.sessionToken = token;
    } catch (error) {
      if (error instanceof VmwareConnectionError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new VmwareConnectionError(
        `Failed to authenticate with vCenter at ${this.host}: ${message}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Return the cached session token, authenticating first if needed.
   */
  async getSessionToken(): Promise<string> {
    if (!this.sessionToken) {
      await this.authenticate();
    }
    return this.sessionToken!;
  }

  /**
   * Invalidate the cached token and force re-authentication
   * on the next request.
   */
  invalidateToken(): void {
    this.sessionToken = null;
  }

  /**
   * Terminate the vCenter session gracefully.
   */
  async disconnect(): Promise<void> {
    if (!this.sessionToken) {
      return;
    }

    try {
      await this.client.delete('/api/session', {
        headers: { 'vmware-api-session-id': this.sessionToken },
      });
    } catch {
      // Best-effort cleanup; swallow errors during disconnect.
    } finally {
      this.sessionToken = null;
    }
  }

  /**
   * Return an Axios instance pre-configured with the base URL
   * and TLS settings. Callers must add the session header themselves
   * (or use VmwareRestClient which does this automatically).
   */
  getClient(): AxiosInstance {
    return this.client;
  }
}
