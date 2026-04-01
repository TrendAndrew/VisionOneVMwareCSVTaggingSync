/**
 * Vision One gateway port (driven adapter interface).
 *
 * Abstracts all communication with the Trend Micro Vision One API,
 * allowing the domain to remain infrastructure-agnostic.
 */

import { VisionOneDevice } from '../model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../model/VisionOneCustomTag';

export interface DeviceTagUpdate {
  deviceId: string;
  assetCustomTagIds: string[];
}

export interface DeviceTagUpdateResult {
  deviceId: string;
  status: number;
  error?: string;
}

export interface VisionOneGateway {
  /** Retrieve all ASRM discovered devices. */
  listDevices(): Promise<VisionOneDevice[]>;

  /** Retrieve all custom tags (pre-created in Vision One console). */
  listCustomTags(): Promise<VisionOneCustomTag[]>;

  /**
   * Batch-update device tags (full replacement).
   * POST /v3.0/asrm/attackSurfaceDevices/update
   * Returns 207 multi-status with per-device results.
   */
  updateDeviceTags(updates: DeviceTagUpdate[]): Promise<DeviceTagUpdateResult[]>;
}
