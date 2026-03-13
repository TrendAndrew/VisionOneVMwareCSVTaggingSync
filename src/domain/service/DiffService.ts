/**
 * Pure domain service that computes tag diffs between VMware VM tags
 * and Vision One endpoint tags.
 *
 * Determines which tags need to be added or removed from each
 * endpoint to reach the desired state derived from VMware tags.
 */

import crypto from 'crypto';
import { EndpointMatch } from '../model/EndpointMatch';
import { SyncStateEntry } from '../model/SyncState';
import { TagDiff } from '../model/TagDiff';

export interface DiffConfig {
  /** When true, tags present in sync state but absent from desired tags are removed. */
  removeOrphanedTags: boolean;
}

export class DiffService {
  constructor(private readonly config: DiffConfig) {}

  /**
   * Compute tag diffs for all matched endpoints.
   *
   * For each match, compares the desired Vision One tag names (derived from
   * VMware tags) against the last-synced tags stored in sync state.
   * Returns only diffs where actual changes are needed.
   *
   * @param matches - The matched VM-endpoint pairs.
   * @param syncState - The last-known sync state keyed by agentGuid.
   * @param existingV1TagNames - Set of tag names that currently exist in Vision One.
   * @param desiredTagsByAgentGuid - Pre-computed desired V1 tag names per agentGuid
   *        (produced by TagNamingService in application layer).
   * @returns Array of TagDiff objects describing required changes per endpoint.
   */
  computeDiffs(
    matches: EndpointMatch[],
    syncState: Map<string, SyncStateEntry>,
    existingV1TagNames: Set<string>,
    desiredTagsByAgentGuid?: Map<string, string[]>
  ): TagDiff[] {
    const diffs: TagDiff[] = [];

    for (const match of matches) {
      const agentGuid = match.visionOneEndpoint.agentGuid;
      const desiredTags = desiredTagsByAgentGuid?.get(agentGuid)
        ?? this.deriveDesiredTags(match);

      const diff = this.computeSingleDiff(match, desiredTags, syncState);
      if (diff !== null) {
        diffs.push(diff);
      }
    }

    return diffs;
  }

  /**
   * Compute a deterministic SHA-256 hash of a sorted tag list.
   * Used for fast change detection without comparing full arrays.
   *
   * @param tags - Array of tag name strings.
   * @returns Hex-encoded SHA-256 hash.
   */
  computeTagHash(tags: string[]): string {
    const sorted = [...tags].sort();
    const joined = sorted.join('\0');
    return crypto.createHash('sha256').update(joined).digest('hex');
  }

  /**
   * Compute the diff for a single match.
   * Returns null if no changes are needed.
   */
  private computeSingleDiff(
    match: EndpointMatch,
    desiredTags: string[],
    syncState: Map<string, SyncStateEntry>
  ): TagDiff | null {
    const agentGuid = match.visionOneEndpoint.agentGuid;
    const entry = syncState.get(agentGuid);

    // If sync state exists and hash hasn't changed, skip
    if (entry && !this.hasChanged(desiredTags, entry)) {
      return null;
    }

    const lastSyncedTags = entry?.lastSyncedTags ?? [];
    const lastSyncedSet = new Set(lastSyncedTags);
    const desiredSet = new Set(desiredTags);

    const tagsToAdd = desiredTags.filter((tag) => !lastSyncedSet.has(tag));

    let tagsToRemove: string[] = [];
    if (this.config.removeOrphanedTags) {
      tagsToRemove = lastSyncedTags.filter((tag) => !desiredSet.has(tag));
    }

    if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
      return null;
    }

    return {
      endpointMatch: match,
      tagsToAdd,
      tagsToRemove,
    };
  }

  /**
   * Derive desired Vision One tag names from a match's VMware VM tags.
   *
   * This is a fallback when pre-computed tag names are not provided.
   * Uses the VM tags that have a resolved categoryName.
   */
  private deriveDesiredTags(match: EndpointMatch): string[] {
    return match.vmwareVm.tags
      .filter((t) => t.categoryName !== undefined)
      .map((t) => `${t.categoryName}/${t.name}`);
  }

  /**
   * Compare the hash of current desired tags against the stored sync state hash.
   *
   * @returns true if the tags have changed since last sync.
   */
  private hasChanged(currentTags: string[], entry: SyncStateEntry): boolean {
    const currentHash = this.computeTagHash(currentTags);
    return currentHash !== entry.lastSyncHash;
  }
}
