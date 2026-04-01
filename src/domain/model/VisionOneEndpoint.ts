/**
 * Vision One device domain model.
 *
 * Represents a discovered device as reported by the
 * Trend Micro Vision One ASRM (Attack Surface Risk Management) API.
 */

export interface VisionOneDevice {
  /** ASRM device ID on the Vision One platform. */
  id: string;
  /** Device hostname as reported by Vision One. */
  deviceName: string;
  /** IP addresses associated with the device. */
  ipAddresses: string[];
  /** Operating system name (e.g., "CentOS 7 3.10.0"). */
  osName: string;
  /** Tag IDs currently assigned to this device. */
  assetCustomTagIds: string[];
}
