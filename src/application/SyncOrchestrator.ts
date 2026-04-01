/**
 * Main synchronization orchestrator.
 *
 * Coordinates the full sync workflow:
 *  1. Connect to VMware and fetch VMs with resolved tags
 *  2. Fetch Vision One devices and existing custom tags
 *  3. Apply admin mapping overrides (highest priority)
 *  4. Run automatic matching on remaining VMs/devices
 *  5. Write an unmatched report for admin review
 *  6. Resolve VMware tags to Vision One tag IDs (key/value match)
 *  7. Compute tag diffs (desired vs. last-synced state)
 *  8. Apply tag updates via batch device update API
 *  9. Persist updated sync state
 */

import { VmwareGateway } from '../domain/port/VmwareGateway';
import { VisionOneGateway, DeviceTagUpdate } from '../domain/port/VisionOneGateway';
import { SyncStateRepository } from '../domain/port/SyncStateRepository';
import { MappingOverrideProvider } from '../domain/port/MappingOverrideProvider';
import { Logger } from '../domain/port/Logger';
import { MatchingService } from '../domain/service/MatchingService';
import { DiffService } from '../domain/service/DiffService';
import { UnmatchedReporter } from '../infrastructure/logging/UnmatchedReporter';
import { DeviceMatch } from '../domain/model/EndpointMatch';
import { VmwareVm } from '../domain/model/VmwareVm';
import { VisionOneDevice } from '../domain/model/VisionOneEndpoint';
import { VisionOneCustomTag } from '../domain/model/VisionOneCustomTag';

export interface SyncResult {
  matchedCount: number;
  unmatchedVmCount: number;
  unmatchedDeviceCount: number;
  tagsCreated: number;       // kept for backward compat but always 0
  devicesUpdated: number;
  deviceUpdateErrors: number;
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
    private readonly mappingOverrides: MappingOverrideProvider,
    private readonly unmatchedReporter: UnmatchedReporter,
    private readonly logger: Logger
  ) {}

  /**
   * Execute a full sync cycle.
   *
   * This is the main entry point. It fetches data from both sides,
   * matches VMs to devices, computes diffs, and applies changes.
   */
  async execute(): Promise<SyncResult> {
    const start = Date.now();
    const result: SyncResult = {
      matchedCount: 0,
      unmatchedVmCount: 0,
      unmatchedDeviceCount: 0,
      tagsCreated: 0,
      devicesUpdated: 0,
      deviceUpdateErrors: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      // Step 1: Connect to VMware
      this.logger.info('Connecting to VMware vCenter');
      await this.vmwareGateway.connect();

      // Step 2: Fetch data in parallel
      this.logger.info('Fetching VMs, devices, tags, and sync state');
      const [vms, devices, existingTags, syncState] = await Promise.all([
        this.fetchVmsWithTags(),
        this.visionOneGateway.listDevices(),
        this.visionOneGateway.listCustomTags(),
        this.syncStateRepo.load(),
      ]);

      this.logger.info('Data fetched', {
        vmCount: vms.length,
        deviceCount: devices.length,
        existingTagCount: existingTags.length,
        syncStateEntries: syncState.entries.size,
      });

      // Step 3: Apply mapping overrides first (highest priority)
      const overrideMatches = this.applyOverrides(vms, devices);
      if (overrideMatches.length > 0) {
        this.logger.info('Mapping overrides applied', {
          overrideCount: overrideMatches.length,
        });
      }

      // Step 4: Run automatic matching on remaining VMs and devices
      const overrideVmIds = new Set(
        overrideMatches.map((m) => m.vmwareVm.vmId)
      );
      const overrideDeviceIds = new Set(
        overrideMatches.map((m) => m.visionOneDevice.id)
      );

      const remainingVms = vms.filter(
        (vm) => !overrideVmIds.has(vm.vmId)
      );
      const remainingDevices = devices.filter(
        (d) => !overrideDeviceIds.has(d.id)
      );

      const autoMatches = this.matchingService.match(
        remainingVms,
        remainingDevices
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
        devices,
        allMatches
      );
      result.unmatchedVmCount = report.unmatchedVms.length;
      result.unmatchedDeviceCount = report.unmatchedDevices.length;

      if (report.unmatchedVms.length > 0) {
        this.logger.warn(
          `${report.unmatchedVms.length} VMs unmatched -- see unmatched report`,
          { count: report.unmatchedVms.length }
        );
      }

      if (report.unmatchedDevices.length > 0) {
        this.logger.warn(
          `${report.unmatchedDevices.length} devices unmatched`,
          { count: report.unmatchedDevices.length }
        );
      }

      // Step 6: Resolve VMware tags to Vision One tag IDs via key/value matching
      const tagLookup = new Map<string, string>();
      for (const tag of existingTags) {
        tagLookup.set(`${tag.key}::${tag.value}`, tag.tagId);
      }

      const desiredTagIdsByDeviceId = new Map<string, string[]>();
      const desiredTagNamesByDeviceId = new Map<string, string[]>();
      for (const match of allMatches) {
        const device = match.visionOneDevice;
        const tagIds: string[] = [];
        const tagNames: string[] = [];
        for (const vmTag of match.vmwareVm.tags) {
          if (!vmTag.categoryName) continue;
          const lookupKey = `${vmTag.categoryName}::${vmTag.name}`;
          const tagId = tagLookup.get(lookupKey);
          if (tagId) {
            tagIds.push(tagId);
            tagNames.push(`${vmTag.categoryName}/${vmTag.name}`);
          } else {
            this.logger.warn(
              `No Vision One tag found for VMware tag "${vmTag.categoryName}/${vmTag.name}" — ` +
              'ensure the tag is pre-created in the Vision One console',
              { category: vmTag.categoryName, tag: vmTag.name, deviceId: device.id }
            );
          }
        }
        desiredTagIdsByDeviceId.set(device.id, tagIds);
        desiredTagNamesByDeviceId.set(device.id, tagNames);
      }

      // Step 7: Compute diffs against sync state
      const existingTagNames = new Set<string>();
      for (const tag of existingTags) {
        existingTagNames.add(`${tag.key}/${tag.value}`);
      }
      const diffs = this.diffService.computeDiffs(
        allMatches,
        syncState.entries,
        existingTagNames,
        desiredTagNamesByDeviceId
      );

      this.logger.info('Diffs computed', { diffCount: diffs.length });

      // Step 8: Apply tag updates via batch device update API
      const updates: DeviceTagUpdate[] = [];

      for (const diff of diffs) {
        const device = diff.deviceMatch.visionOneDevice;
        const desiredIds = desiredTagIdsByDeviceId.get(device.id) ?? [];

        // Start with current non-managed tag IDs (preserve tags we don't manage)
        const currentTagIds = new Set(device.assetCustomTagIds);

        // Remove tags that are in tagsToRemove
        for (const tagName of diff.tagsToRemove) {
          const parts = tagName.split('/');
          if (parts.length >= 2) {
            const lookupKey = `${parts[0]}::${parts.slice(1).join('/')}`;
            const tagId = tagLookup.get(lookupKey);
            if (tagId) currentTagIds.delete(tagId);
          }
        }

        // Add tags that are in tagsToAdd
        for (const tagName of diff.tagsToAdd) {
          const parts = tagName.split('/');
          if (parts.length >= 2) {
            const lookupKey = `${parts[0]}::${parts.slice(1).join('/')}`;
            const tagId = tagLookup.get(lookupKey);
            if (tagId) currentTagIds.add(tagId);
          }
        }

        const finalTagIds = [...currentTagIds];

        if (finalTagIds.length > 20) {
          this.logger.warn(`Device ${device.id} would exceed 20 tag limit, truncating`, {
            deviceId: device.id,
            tagCount: finalTagIds.length,
          });
          finalTagIds.length = 20;
        }

        updates.push({ deviceId: device.id, assetCustomTagIds: finalTagIds });
      }

      if (updates.length > 0) {
        const results = await this.visionOneGateway.updateDeviceTags(updates);
        for (const r of results) {
          if (r.status === 204) {
            result.devicesUpdated++;
          } else {
            result.deviceUpdateErrors++;
            result.errors.push(r.error ?? `Device ${r.deviceId} update failed`);
          }
        }
      }

      // Step 9: Update sync state
      const updatedEntries = new Map(syncState.entries);
      for (const diff of diffs) {
        const vm = diff.deviceMatch.vmwareVm;
        const device = diff.deviceMatch.visionOneDevice;
        const desiredTags = desiredTagNamesByDeviceId.get(device.id) ?? [];

        updatedEntries.set(device.id, {
          vmId: vm.vmId,
          deviceId: device.id,
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
      unmatchedDevices: result.unmatchedDeviceCount,
      tagsCreated: result.tagsCreated,
      devicesUpdated: result.devicesUpdated,
      deviceUpdateErrors: result.deviceUpdateErrors,
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
   * Apply mapping overrides to create forced DeviceMatch entries.
   *
   * For each VM that has a mapping override, look up both the VM and
   * the target device. If both exist, create a match with override
   * metadata.
   */
  private applyOverrides(
    vms: VmwareVm[],
    devices: VisionOneDevice[]
  ): DeviceMatch[] {
    const matches: DeviceMatch[] = [];
    const deviceMap = new Map(
      devices.map((d) => [d.id, d])
    );

    for (const vm of vms) {
      const override = this.mappingOverrides.getOverride(vm.vmId);
      if (!override) {
        continue;
      }

      const device = deviceMap.get(override.deviceId);
      if (!device) {
        this.logger.warn(
          `Mapping override for VM "${vm.vmId}" references unknown device "${override.deviceId}"`,
          { vmId: vm.vmId, deviceId: override.deviceId }
        );
        continue;
      }

      matches.push({
        vmwareVm: vm,
        visionOneDevice: device,
        matchedOn: 'hostname', // override-based, treated as exact
        confidence: 'exact',
      });
    }

    return matches;
  }
}
