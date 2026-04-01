/**
 * Vision One gateway implementation using the ASRM REST API.
 *
 * Implements the VisionOneGateway port by translating domain
 * operations into Vision One ASRM API calls.
 */

import { VisionOneGateway, DeviceTagUpdate, DeviceTagUpdateResult } from '../../domain/port/VisionOneGateway';
import { VisionOneDevice } from '../../domain/model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../../domain/model/VisionOneCustomTag';
import { VisionOneRestClient } from './VisionOneRestClient';
import { VisionOnePaginator } from './VisionOnePaginator';
import { VisionOneApiError } from '../../shared/errors';

/** Raw device from GET /v3.0/asrm/attackSurfaceDevices */
interface RawDevice {
  id: string;
  deviceName: string;
  ip?: string[];
  osName?: string;
  osPlatform?: string;
  assetCustomTags?: string[];
}

/** Raw custom tag from GET /v3.0/asrm/attackSurfaceCustomTags */
interface RawCustomTag {
  id: string;
  key: string;
  value: string;
}

/** Per-item result in 207 multi-status response */
interface UpdateResultItem {
  status: number;
}

export class VisionOneGatewayImpl implements VisionOneGateway {
  private readonly client: VisionOneRestClient;
  private readonly paginator: VisionOnePaginator<RawDevice>;

  constructor(
    apiToken: string,
    region: string,
    devicePageSize: number = 200,
    requestTimeoutMs: number = 30000,
    rateLimitDelayMs: number = 100
  ) {
    this.client = new VisionOneRestClient(
      apiToken,
      region,
      requestTimeoutMs,
      rateLimitDelayMs
    );
    this.paginator = new VisionOnePaginator<RawDevice>(
      this.client,
      devicePageSize
    );
  }

  async listDevices(): Promise<VisionOneDevice[]> {
    const rawDevices = await this.paginator.fetchAll(
      '/v3.0/asrm/attackSurfaceDevices'
    );

    return rawDevices.map((raw) => this.mapDevice(raw));
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
      key: raw.key,
      value: raw.value,
    }));
  }

  /**
   * Batch-update device tags using full replacement semantics.
   *
   * POST /v3.0/asrm/attackSurfaceDevices/update
   * Body: [{ "id": "<deviceId>", "assetCustomTagIds": ["tagId1", ...] }]
   * Response: 207 with [{ "status": 204 }] per item
   */
  async updateDeviceTags(
    updates: DeviceTagUpdate[]
  ): Promise<DeviceTagUpdateResult[]> {
    if (updates.length === 0) {
      return [];
    }

    const body = updates.map((u) => ({
      id: u.deviceId,
      assetCustomTagIds: u.assetCustomTagIds,
    }));

    const response = await this.client.post<UpdateResultItem[]>(
      '/v3.0/asrm/attackSurfaceDevices/update',
      body
    );

    const results = Array.isArray(response) ? response : [];

    return updates.map((u, i) => ({
      deviceId: u.deviceId,
      status: results[i]?.status ?? 500,
      error:
        results[i]?.status !== 204
          ? `Device ${u.deviceId} tag update failed with status ${results[i]?.status ?? 'unknown'}`
          : undefined,
    }));
  }

  private mapDevice(raw: RawDevice): VisionOneDevice {
    return {
      id: raw.id,
      deviceName: raw.deviceName ?? '',
      ipAddresses: raw.ip ?? [],
      osName: raw.osName ?? '',
      assetCustomTagIds: raw.assetCustomTags ?? [],
    };
  }
}
