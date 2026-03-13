/**
 * Vision One gateway port (driven adapter interface).
 *
 * Abstracts all communication with the Trend Micro Vision One API,
 * allowing the domain to remain infrastructure-agnostic.
 */

import { VisionOneEndpoint } from '../model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../model/VisionOneCustomTag';

export interface VisionOneGateway {
  /** Retrieve all managed endpoints. */
  listEndpoints(): Promise<VisionOneEndpoint[]>;

  /** Retrieve all custom tags. */
  listCustomTags(): Promise<VisionOneCustomTag[]>;

  /** Create a new custom tag and return the created entity. */
  createCustomTag(name: string): Promise<VisionOneCustomTag>;

  /** Apply a single tag to an endpoint. */
  applyTagToEndpoint(tagId: string, agentGuid: string): Promise<void>;

  /** Remove a single tag from an endpoint. */
  removeTagFromEndpoint(tagId: string, agentGuid: string): Promise<void>;

  /** Apply multiple tags to an endpoint in a single operation. */
  applyTagsToEndpoint(tagIds: string[], agentGuid: string): Promise<void>;
}
