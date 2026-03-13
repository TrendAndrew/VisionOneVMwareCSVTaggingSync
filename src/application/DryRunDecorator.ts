/**
 * Dry-run decorator for the VisionOneGateway.
 *
 * Wraps a real VisionOneGateway implementation. Read operations
 * (listEndpoints, listCustomTags) are delegated to the inner gateway.
 * Write operations (create tag, apply tag, remove tag) are intercepted
 * and logged without actually calling the Vision One API.
 */

import { VisionOneGateway } from '../domain/port/VisionOneGateway';
import { VisionOneEndpoint } from '../domain/model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../domain/model/VisionOneCustomTag';
import { Logger } from '../domain/port/Logger';

export class DryRunDecorator implements VisionOneGateway {
  constructor(
    private readonly inner: VisionOneGateway,
    private readonly logger: Logger
  ) {}

  /** Delegate to the real gateway -- read-only, safe in dry-run. */
  async listEndpoints(): Promise<VisionOneEndpoint[]> {
    return this.inner.listEndpoints();
  }

  /** Delegate to the real gateway -- read-only, safe in dry-run. */
  async listCustomTags(): Promise<VisionOneCustomTag[]> {
    return this.inner.listCustomTags();
  }

  /** Log instead of creating a tag. Returns a synthetic tag object. */
  async createCustomTag(name: string): Promise<VisionOneCustomTag> {
    this.logger.info('[DRY RUN] Would create custom tag', { tagName: name });
    return {
      tagId: `dry-run-${Date.now()}-${name}`,
      tagName: name,
    };
  }

  /** Log instead of applying a tag to an endpoint. */
  async applyTagToEndpoint(
    tagId: string,
    agentGuid: string
  ): Promise<void> {
    this.logger.info('[DRY RUN] Would apply tag to endpoint', {
      tagId,
      agentGuid,
    });
  }

  /** Log instead of removing a tag from an endpoint. */
  async removeTagFromEndpoint(
    tagId: string,
    agentGuid: string
  ): Promise<void> {
    this.logger.info('[DRY RUN] Would remove tag from endpoint', {
      tagId,
      agentGuid,
    });
  }

  /** Log instead of applying multiple tags to an endpoint. */
  async applyTagsToEndpoint(
    tagIds: string[],
    agentGuid: string
  ): Promise<void> {
    this.logger.info('[DRY RUN] Would apply multiple tags to endpoint', {
      tagIds,
      tagCount: tagIds.length,
      agentGuid,
    });
  }
}
