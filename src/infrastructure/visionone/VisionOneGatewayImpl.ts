/**
 * Vision One gateway implementation using the Vision One REST API.
 *
 * Implements the VisionOneGateway port by translating domain
 * operations into Vision One API calls.
 */

import { VisionOneGateway } from '../../domain/port/VisionOneGateway';
import { VisionOneEndpoint } from '../../domain/model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../../domain/model/VisionOneCustomTag';
import { VisionOneRestClient } from './VisionOneRestClient';
import { VisionOnePaginator } from './VisionOnePaginator';
import { VisionOneApiError } from '../../shared/errors';

/** Raw endpoint from GET /v3.0/endpointSecurity/endpoints */
interface RawEndpoint {
  agentGuid: string;
  endpointName: string;
  displayName?: string;
  ip?: string;
  ips?: string[];
  osName?: string;
  tags?: string[];
}

/** Raw custom tag from GET /v3.0/asrm/attackSurfaceCustomTags */
interface RawCustomTag {
  id: string;
  name: string;
  tagName?: string;
}

/** Response from POST /v3.0/asrm/attackSurfaceCustomTags */
interface CreateTagResponse {
  id: string;
  name?: string;
  tagName?: string;
}

export class VisionOneGatewayImpl implements VisionOneGateway {
  private readonly client: VisionOneRestClient;
  private readonly paginator: VisionOnePaginator<RawEndpoint>;

  constructor(
    apiToken: string,
    region: string,
    endpointPageSize: number = 200,
    requestTimeoutMs: number = 30000,
    rateLimitDelayMs: number = 100
  ) {
    this.client = new VisionOneRestClient(
      apiToken,
      region,
      requestTimeoutMs,
      rateLimitDelayMs
    );
    this.paginator = new VisionOnePaginator<RawEndpoint>(
      this.client,
      endpointPageSize
    );
  }

  async listEndpoints(): Promise<VisionOneEndpoint[]> {
    const rawEndpoints = await this.paginator.fetchAll(
      '/v3.0/endpointSecurity/endpoints'
    );

    return rawEndpoints.map((raw) => this.mapEndpoint(raw));
  }

  async listCustomTags(): Promise<VisionOneCustomTag[]> {
    const response = await this.client.get<{ items: RawCustomTag[] }>(
      '/v3.0/asrm/attackSurfaceCustomTags'
    );

    const items = Array.isArray(response)
      ? response
      : (response?.items ?? []);

    return items.map((raw: RawCustomTag) => ({
      tagId: raw.id,
      tagName: raw.tagName ?? raw.name,
    }));
  }

  async createCustomTag(name: string): Promise<VisionOneCustomTag> {
    if (!name || name.trim().length === 0) {
      throw new VisionOneApiError('Tag name must not be empty');
    }

    const response = await this.client.post<CreateTagResponse>(
      '/v3.0/asrm/attackSurfaceCustomTags',
      { tagName: name }
    );

    return {
      tagId: response.id,
      tagName: response.tagName ?? response.name ?? name,
    };
  }

  /**
   * Apply a single tag to an endpoint.
   *
   * NOTE: The exact endpoint for tag application is not publicly
   * documented in the Vision One API reference. The path below
   * follows the most likely convention. Verify against the actual
   * API documentation or sandbox before production use.
   */
  async applyTagToEndpoint(
    tagId: string,
    agentGuid: string
  ): Promise<void> {
    this.validateIds(tagId, agentGuid);

    await this.client.patch<unknown>(
      `/v3.0/endpointSecurity/endpoints/${encodeURIComponent(agentGuid)}/tags`,
      { add: [tagId] }
    );
  }

  /**
   * Remove a single tag from an endpoint.
   *
   * NOTE: Exact endpoint needs verification against actual API.
   * See applyTagToEndpoint comment above.
   */
  async removeTagFromEndpoint(
    tagId: string,
    agentGuid: string
  ): Promise<void> {
    this.validateIds(tagId, agentGuid);

    await this.client.patch<unknown>(
      `/v3.0/endpointSecurity/endpoints/${encodeURIComponent(agentGuid)}/tags`,
      { remove: [tagId] }
    );
  }

  /**
   * Apply multiple tags to an endpoint in a single API call.
   *
   * NOTE: Exact endpoint needs verification against actual API.
   * See applyTagToEndpoint comment above.
   */
  async applyTagsToEndpoint(
    tagIds: string[],
    agentGuid: string
  ): Promise<void> {
    if (!agentGuid) {
      throw new VisionOneApiError('agentGuid must not be empty');
    }

    if (tagIds.length === 0) {
      return;
    }

    await this.client.patch<unknown>(
      `/v3.0/endpointSecurity/endpoints/${encodeURIComponent(agentGuid)}/tags`,
      { add: tagIds }
    );
  }

  private mapEndpoint(raw: RawEndpoint): VisionOneEndpoint {
    const ipAddresses: string[] = [];

    if (raw.ips && Array.isArray(raw.ips)) {
      ipAddresses.push(...raw.ips);
    } else if (raw.ip) {
      ipAddresses.push(raw.ip);
    }

    return {
      agentGuid: raw.agentGuid,
      endpointName: raw.endpointName ?? '',
      displayName: raw.displayName ?? raw.endpointName ?? '',
      ipAddresses,
      osName: raw.osName ?? '',
      customTags: raw.tags ?? [],
    };
  }

  private validateIds(tagId: string, agentGuid: string): void {
    if (!tagId) {
      throw new VisionOneApiError('tagId must not be empty');
    }
    if (!agentGuid) {
      throw new VisionOneApiError('agentGuid must not be empty');
    }
  }
}
