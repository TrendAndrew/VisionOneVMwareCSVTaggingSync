/**
 * Dry-run decorator for the VisionOneGateway.
 *
 * Wraps a real VisionOneGateway implementation. Read operations
 * (listDevices, listCustomTags) are delegated to the inner gateway.
 * Write operations (updateDeviceTags) are intercepted and logged
 * without actually calling the Vision One API.
 */

import { VisionOneGateway, DeviceTagUpdate, DeviceTagUpdateResult } from '../domain/port/VisionOneGateway';
import { VisionOneDevice } from '../domain/model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../domain/model/VisionOneCustomTag';
import { Logger } from '../domain/port/Logger';

export class DryRunDecorator implements VisionOneGateway {
  constructor(
    private readonly inner: VisionOneGateway,
    private readonly logger: Logger
  ) {}

  /** Delegate to the real gateway -- read-only, safe in dry-run. */
  async listDevices(): Promise<VisionOneDevice[]> {
    return this.inner.listDevices();
  }

  /** Delegate to the real gateway -- read-only, safe in dry-run. */
  async listCustomTags(): Promise<VisionOneCustomTag[]> {
    return this.inner.listCustomTags();
  }

  /** Log instead of updating device tags. Simulate all-success. */
  async updateDeviceTags(
    updates: DeviceTagUpdate[]
  ): Promise<DeviceTagUpdateResult[]> {
    for (const u of updates) {
      this.logger.info('[DRY RUN] Would update device tags (full replacement)', {
        deviceId: u.deviceId,
        tagCount: u.assetCustomTagIds.length,
        tagIds: u.assetCustomTagIds,
      });
    }
    return updates.map((u) => ({ deviceId: u.deviceId, status: 204 }));
  }
}
