/**
 * Vision One endpoint domain model.
 *
 * Represents a managed endpoint as reported by the
 * Trend Micro Vision One API.
 */

export interface VisionOneEndpoint {
  agentGuid: string;
  endpointName: string;
  displayName: string;
  ipAddresses: string[];
  osName: string;
  customTags: string[];
}
