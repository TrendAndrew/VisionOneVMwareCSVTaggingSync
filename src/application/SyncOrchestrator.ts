/**
 * Main synchronization orchestrator.
 *
 * Coordinates the full sync workflow:
 *  1. Connect to VMware and fetch VMs with resolved tags
 *  2. Fetch Vision One endpoints and existing custom tags
 *  3. Apply admin mapping overrides (highest priority)
 *  4. Run automatic matching on remaining VMs/endpoints
 *  5. Write an unmatched report for admin review
 *  6. Compute tag diffs (desired vs. last-synced state)
 *  7. Create any missing Vision One custom tags
 *  8. Apply and remove tags to reach desired state
 *  9. Persist updated sync state
 */

import { VmwareGateway } from '../domain/port/VmwareGateway';
import { VisionOneGateway } from '../domain/port/VisionOneGateway';
import { SyncStateRepository } from '../domain/port/SyncStateRepository';
import { MappingOverrideProvider } from '../domain/port/MappingOverrideProvider';
import { Logger } from '../domain/port/Logger';
import { MatchingService } from '../domain/service/MatchingService';
import { DiffService } from '../domain/service/DiffService';
import { TagNamingService } from '../domain/service/TagNamingService';
import { UnmatchedReporter } from '../infrastructure/logging/UnmatchedReporter';
import { EndpointMatch } from '../domain/model/EndpointMatch';
import { VmwareVm } from '../domain/model/VmwareVm';
import { VisionOneEndpoint } from '../domain/model/VisionOneEndpoint';

export interface SyncResult {
  matchedCount: number;
  unmatchedVmCount: number;
  unmatchedEndpointCount: number;
  tagsCreated: number;
  tagsApplied: number;
  tagsRemoved: number;
  errors: string[];
  durationMs: number;
}

export class SyncOrchestrator {
  constructor(
    private readonly vmwareGateway: VmwareGateway,
    private readonly visionOneGateway: VisionOneGateway,
    private readonly syncStateRepo: SyncStateRepository,
    private readonly matchingService: MatchingService,
    private readonly diffService: DiffService,
    private readonly tagNamingService: TagNamingService,
    private readonly mappingOverrides: MappingOverrideProvider,
    private readonly unmatchedReporter: UnmatchedReporter,
    private readonly logger: Logger
  ) {}

  /**
   * Execute a full sync cycle.
   *
   * This is the main entry point. It fetches data from both sides,
   * matches VMs to endpoints, computes diffs, and applies changes.
   */
  async execute(): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = {
      matchedCount: 0,
      unmatchedVmCount: 0,
      unmatchedEndpointCount: 0,
      tagsCreated: 0,
      tagsApplied: 0,
      tagsRemoved: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      // Step 1: Connect to VMware
      this.logger.info('Connecting to VMware vCenter');
      await this.vmwareGateway.connect();

      // Step 2: Fetch data in parallel
      this.logger.info('Fetching VMs, endpoints, tags, and sync state');
      const [vms, endpoints, existingTags, syncState] = await Promise.all([
        this.fetchVmsWithTags(),
        this.visionOneGateway.listEndpoints(),
        this.visionOneGateway.listCustomTags(),
        this.syncStateRepo.load(),
      ]);

      this.logger.info('Data fetched', {
        vmCount: vms.length,
        endpointCount: endpoints.length,
        existingTagCount: existingTags.length,
        syncStateEntries: syncState.entries.size,
      });

      // Step 3: Apply mapping overrides first (highest priority)
      const overrideMatches = this.applyOverrides(vms, endpoints);
      if (overrideMatches.length > 0) {
        this.logger.info('Mapping overrides applied', {
          overrideCount: overrideMatches.length,
        });
      }

      // Step 4: Run automatic matching on remaining VMs and endpoints
      const overrideVmIds = new Set(
        overrideMatches.map((m) => m.vmwareVm.vmId)
      );
      const overrideEndpointGuids = new Set(
        overrideMatches.map((m) => m.visionOneEndpoint.agentGuid)
      );

      const remainingVms = vms.filter(
        (vm) => !overrideVmIds.has(vm.vmId)
      );
      const remainingEndpoints = endpoints.filter(
        (ep) => !overrideEndpointGuids.has(ep.agentGuid)
      );

      const autoMatches = this.matchingService.match(
        remainingVms,
        remainingEndpoints
      );
      const allMatches = [...overrideMatches, ...autoMatches];
      result.matchedCount = allMatches.length;

      this.logger.info('Matching complete', {
        overrideMatches: overrideMatches.length,
        autoMatches: autoMatches.length,
        totalMatches: allMatches.length,
      });

      // Step 5: Write unmatched report
      const report = await this.unmatchedReporter.writeReport(
        vms,
        endpoints,
        allMatches
      );
      result.unmatchedVmCount = report.unmatchedVms.length;
      result.unmatchedEndpointCount = report.unmatchedEndpoints.length;

      if (report.unmatchedVms.length > 0) {
        this.logger.warn(
          `${report.unmatchedVms.length} VMs unmatched -- see unmatched report`,
          { count: report.unmatchedVms.length }
        );
      }

      if (report.unmatchedEndpoints.length > 0) {
        this.logger.warn(
          `${report.unmatchedEndpoints.length} endpoints unmatched`,
          { count: report.unmatchedEndpoints.length }
        );
      }

      // Step 6: Pre-compute desired V1 tag names for each matched endpoint
      const desiredTagsByAgentGuid = this.computeDesiredTags(allMatches);

      // Step 7: Compute diffs against sync state
      const existingTagNames = new Set(
        existingTags.map((t) => t.tagName)
      );
      const diffs = this.diffService.computeDiffs(
        allMatches,
        syncState.entries,
        existingTagNames,
        desiredTagsByAgentGuid
      );

      this.logger.info('Diffs computed', { diffCount: diffs.length });

      // Step 8: Create missing tags in Vision One
      const tagNameToId = new Map(
        existingTags.map((t) => [t.tagName, t.tagId])
      );

      for (const diff of diffs) {
        for (const tagName of diff.tagsToAdd) {
          if (!tagNameToId.has(tagName)) {
            try {
              const created =
                await this.visionOneGateway.createCustomTag(tagName);
              tagNameToId.set(created.tagName, created.tagId);
              result.tagsCreated++;
            } catch (err) {
              const msg = `Failed to create tag "${tagName}": ${
                err instanceof Error ? err.message : String(err)
              }`;
              this.logger.error(
                msg,
                err instanceof Error ? err : new Error(String(err))
              );
              result.errors.push(msg);
            }
          }
        }
      }

      // Step 9: Apply and remove tags
      for (const diff of diffs) {
        const agentGuid = diff.endpointMatch.visionOneEndpoint.agentGuid;

        for (const tagName of diff.tagsToAdd) {
          const tagId = tagNameToId.get(tagName);
          if (tagId) {
            try {
              await this.visionOneGateway.applyTagToEndpoint(
                tagId,
                agentGuid
              );
              result.tagsApplied++;
            } catch (err) {
              const msg = `Failed to apply tag "${tagName}" to ${agentGuid}: ${
                err instanceof Error ? err.message : String(err)
              }`;
              this.logger.error(
                msg,
                err instanceof Error ? err : new Error(String(err))
              );
              result.errors.push(msg);
            }
          }
        }

        for (const tagName of diff.tagsToRemove) {
          const tagId = tagNameToId.get(tagName);
          if (tagId) {
            try {
              await this.visionOneGateway.removeTagFromEndpoint(
                tagId,
                agentGuid
              );
              result.tagsRemoved++;
            } catch (err) {
              const msg = `Failed to remove tag "${tagName}" from ${agentGuid}: ${
                err instanceof Error ? err.message : String(err)
              }`;
              this.logger.error(
                msg,
                err instanceof Error ? err : new Error(String(err))
              );
              result.errors.push(msg);
            }
          }
        }
      }

      // Step 10: Update sync state
      const updatedEntries = new Map(syncState.entries);
      for (const diff of diffs) {
        const vm = diff.endpointMatch.vmwareVm;
        const ep = diff.endpointMatch.visionOneEndpoint;
        const desiredTags = desiredTagsByAgentGuid.get(ep.agentGuid) ?? [];

        updatedEntries.set(ep.agentGuid, {
          vmId: vm.vmId,
          agentGuid: ep.agentGuid,
          lastSyncedTags: desiredTags,
          lastSyncTimestamp: new Date().toISOString(),
          lastSyncHash: this.diffService.computeTagHash(desiredTags),
        });
      }

      await this.syncStateRepo.save({
        entries: updatedEntries,
        lastFullSyncTimestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error(
        'Sync cycle failed',
        err instanceof Error ? err : new Error(String(err))
      );
      result.errors.push(String(err));
    } finally {
      try {
        await this.vmwareGateway.disconnect();
      } catch {
        // Best-effort disconnect; swallow errors.
      }
      result.durationMs = Date.now() - start;
    }

    this.logger.info('Sync cycle complete', {
      matched: result.matchedCount,
      unmatchedVms: result.unmatchedVmCount,
      unmatchedEndpoints: result.unmatchedEndpointCount,
      tagsCreated: result.tagsCreated,
      tagsApplied: result.tagsApplied,
      tagsRemoved: result.tagsRemoved,
      errors: result.errors.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Fetch all VMs from VMware and enrich them with resolved tag data.
   *
   * Fetches VMs, categories, and tags in parallel, then uses the
   * tag association API to attach resolved tags to each VM.
   */
  private async fetchVmsWithTags(): Promise<VmwareVm[]> {
    const [vms, categories, tags] = await Promise.all([
      this.vmwareGateway.listVms(),
      this.vmwareGateway.listCategories(),
      this.vmwareGateway.listTags(),
    ]);

    // Build lookup maps for category and tag resolution
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const tagMap = new Map(
      tags.map((t) => [
        t.id,
        { ...t, categoryName: categoryMap.get(t.categoryId) },
      ])
    );

    // Fetch tag associations for all VMs
    const vmIds = vms.map((vm) => vm.vmId);
    const associations =
      await this.vmwareGateway.getTagAssociationsForVms(vmIds);

    // Enrich each VM with its resolved tags
    for (const vm of vms) {
      const vmTags = associations.get(vm.vmId) ?? [];
      vm.tags = vmTags.map((t) => ({
        ...t,
        categoryName: tagMap.get(t.id)?.categoryName ?? 'Unknown',
      }));
    }

    return vms;
  }

  /**
   * Apply mapping overrides to create forced EndpointMatch entries.
   *
   * For each VM that has a mapping override, look up both the VM and
   * the target endpoint. If both exist, create a match with override
   * metadata.
   */
  private applyOverrides(
    vms: VmwareVm[],
    endpoints: VisionOneEndpoint[]
  ): EndpointMatch[] {
    const matches: EndpointMatch[] = [];
    const endpointMap = new Map(
      endpoints.map((ep) => [ep.agentGuid, ep])
    );

    for (const vm of vms) {
      const override = this.mappingOverrides.getOverride(vm.vmId);
      if (!override) {
        continue;
      }

      const endpoint = endpointMap.get(override.agentGuid);
      if (!endpoint) {
        this.logger.warn(
          `Mapping override for VM "${vm.vmId}" references unknown endpoint "${override.agentGuid}"`,
          { vmId: vm.vmId, agentGuid: override.agentGuid }
        );
        continue;
      }

      matches.push({
        vmwareVm: vm,
        visionOneEndpoint: endpoint,
        matchedOn: 'hostname', // override-based, treated as exact
        confidence: 'exact',
      });
    }

    return matches;
  }

  /**
   * Pre-compute desired Vision One tag names for each matched endpoint.
   *
   * Uses TagNamingService to transform VMware category/tag pairs into
   * properly formatted V1 tag names. The resulting map is keyed by
   * agentGuid for consumption by DiffService.
   */
  private computeDesiredTags(
    matches: EndpointMatch[]
  ): Map<string, string[]> {
    const result = new Map<string, string[]>();

    for (const match of matches) {
      const vm = match.vmwareVm;
      const agentGuid = match.visionOneEndpoint.agentGuid;

      const desiredTags = vm.tags
        .filter((t) => t.categoryName !== undefined && t.categoryName !== '')
        .map((t) =>
          this.tagNamingService.toVisionOneTagName(
            t.categoryName!,
            t.name
          )
        );

      result.set(agentGuid, desiredTags);
    }

    return result;
  }
}
