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

import fs from 'fs/promises';
import path from 'path';
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
  missingTagCount: number;
  errors: string[];
  durationMs: number;
}

interface StepTiming {
  step: string;
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
    const timings: StepTiming[] = [];
    const result: SyncResult = {
      matchedCount: 0,
      unmatchedVmCount: 0,
      unmatchedDeviceCount: 0,
      tagsCreated: 0,
      devicesUpdated: 0,
      deviceUpdateErrors: 0,
      missingTagCount: 0,
      errors: [],
      durationMs: 0,
    };

    const timeStep = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
      const stepStart = Date.now();
      const value = await fn();
      const elapsed = Date.now() - stepStart;
      timings.push({ step, durationMs: elapsed });
      this.logger.info(`${step} completed`, { durationMs: elapsed });
      return value;
    };

    try {
      // Step 1: Connect to VMware
      await timeStep('Connect to VMware', async () => {
        await this.vmwareGateway.connect();
      });

      // Step 2: Fetch data in parallel (VMware + V1 + sync state concurrently)
      this.logger.info('Fetching data from VMware and Vision One in parallel');
      const fetchStart = Date.now();
      const [vms, devices, existingTags, syncState] = await Promise.all([
        this.fetchVmsWithTags(),
        this.visionOneGateway.listDevices().then((d) => {
          this.logger.info('Vision One devices fetched', { deviceCount: d.length });
          return d;
        }),
        this.visionOneGateway.listCustomTags().then((t) => {
          this.logger.info('Vision One custom tags fetched', { tagCount: t.length });
          return t;
        }),
        this.syncStateRepo.load().then((s) => {
          this.logger.debug('Sync state loaded', { entries: s.entries.size });
          return s;
        }),
      ]);
      const fetchElapsed = Date.now() - fetchStart;
      timings.push({ step: 'Fetch all data', durationMs: fetchElapsed });

      this.logger.info('All data fetched', {
        vmCount: vms.length,
        deviceCount: devices.length,
        existingTagCount: existingTags.length,
        syncStateEntries: syncState.entries.size,
        durationMs: fetchElapsed,
      });

      // Step 3: Apply mapping overrides first (highest priority)
      const { matches: overrideMatches, suppressedVmIds } = this.applyOverrides(vms, devices);
      if (overrideMatches.length > 0) {
        this.logger.info('Mapping overrides applied', {
          overrideCount: overrideMatches.length,
        });
      }
      if (suppressedVmIds.size > 0) {
        this.logger.info('VMs suppressed by mapping overrides', {
          suppressedCount: suppressedVmIds.size,
        });
      }

      // Step 4: Run automatic matching on remaining VMs and devices
      const matchStart = Date.now();
      const overrideVmIds = new Set(
        overrideMatches.map((m) => m.vmwareVm.vmId)
      );
      const overrideDeviceIds = new Set(
        overrideMatches.map((m) => m.visionOneDevice.id)
      );

      // Filter out both override-matched and suppressed VMs
      const remainingVms = vms.filter(
        (vm) => !overrideVmIds.has(vm.vmId) && !suppressedVmIds.has(vm.vmId)
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
      const matchElapsed = Date.now() - matchStart;
      timings.push({ step: 'Match VMs to devices', durationMs: matchElapsed });

      this.logger.info('Matching complete', {
        overrideMatches: overrideMatches.length,
        autoMatches: autoMatches.length,
        totalMatches: allMatches.length,
        durationMs: matchElapsed,
      });

      // Step 5: Write unmatched report (exclude suppressed VMs)
      await timeStep('Write unmatched report', async () => {
        const vmsForReport = vms.filter(vm => !suppressedVmIds.has(vm.vmId));
        const report = await this.unmatchedReporter.writeReport(
          vmsForReport,
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
      });

      // Step 6: Resolve VMware tags to Vision One tag IDs via key/value matching
      const resolveStart = Date.now();
      const tagLookup = new Map<string, string>();
      for (const tag of existingTags) {
        tagLookup.set(`${tag.key}::${tag.value}`, tag.tagId);
      }

      const desiredTagIdsByDeviceId = new Map<string, string[]>();
      const desiredTagNamesByDeviceId = new Map<string, string[]>();
      const missingTags = new Set<string>();
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
            missingTags.add(`${vmTag.categoryName}::${vmTag.name}`);
          }
        }
        desiredTagIdsByDeviceId.set(device.id, tagIds);
        desiredTagNamesByDeviceId.set(device.id, tagNames);
      }

      // Write missing tags to CSV for admin to pre-create in Vision One
      result.missingTagCount = missingTags.size;
      if (missingTags.size > 0) {
        await this.writeMissingTagsCsv(missingTags);
      }
      const resolveElapsed = Date.now() - resolveStart;
      timings.push({ step: 'Resolve tags', durationMs: resolveElapsed });

      // Step 7: Compute diffs against live device state
      const diffStart = Date.now();
      const existingTagNames = new Set<string>();
      for (const tag of existingTags) {
        existingTagNames.add(`${tag.key}/${tag.value}`);
      }

      // Build reverse lookup: tagId -> "key/value" name
      const tagIdToName = new Map<string, string>();
      for (const tag of existingTags) {
        tagIdToName.set(tag.tagId, `${tag.key}/${tag.value}`);
      }

      // Build live tag names per device from current assetCustomTagIds
      const liveTagNamesByDeviceId = new Map<string, string[]>();
      for (const device of devices) {
        const names = device.assetCustomTagIds
          .map(id => tagIdToName.get(id))
          .filter((name): name is string => name !== undefined);
        liveTagNamesByDeviceId.set(device.id, names);
      }

      const diffs = this.diffService.computeDiffs(
        allMatches,
        syncState.entries,
        existingTagNames,
        desiredTagNamesByDeviceId,
        liveTagNamesByDeviceId
      );
      const diffElapsed = Date.now() - diffStart;
      timings.push({ step: 'Compute diffs', durationMs: diffElapsed });

      this.logger.info('Diffs computed', { diffCount: diffs.length, durationMs: diffElapsed });

      // Step 8: Apply tag updates via batch device update API
      await timeStep('Apply tag updates', async () => {
        const updates: DeviceTagUpdate[] = [];

        for (const diff of diffs) {
          const device = diff.deviceMatch.visionOneDevice;

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

          // Log detailed diff for visibility (especially useful in dry-run mode)
          this.logger.info('Tag update planned', {
            deviceId: device.id,
            deviceName: device.deviceName,
            vmName: diff.deviceMatch.vmwareVm.name,
            tagsToAdd: diff.tagsToAdd,
            tagsToRemove: diff.tagsToRemove,
            finalTagCount: finalTagIds.length,
          });

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
      });

      // Step 9: Update sync state
      await timeStep('Persist sync state', async () => {
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

    // Final summary with step timings
    const timingSummary: Record<string, number> = {};
    for (const t of timings) {
      timingSummary[t.step] = t.durationMs;
    }

    this.logger.info('Sync cycle complete', {
      matched: result.matchedCount,
      unmatchedVms: result.unmatchedVmCount,
      unmatchedDevices: result.unmatchedDeviceCount,
      devicesUpdated: result.devicesUpdated,
      deviceUpdateErrors: result.deviceUpdateErrors,
      missingTags: result.missingTagCount,
      errors: result.errors.length,
      totalDurationMs: result.durationMs,
      stepTimings: timingSummary,
    });

    if (result.missingTagCount > 0) {
      const csvPath = path.resolve('./data/missing-tags.csv');
      this.logger.info(
        `${result.missingTagCount} VMware tag(s) not found in Vision One — pre-create them from ${csvPath}`
      );
    }

    return result;
  }

  /**
   * Fetch all VMs from VMware and enrich them with resolved tag data.
   *
   * Fetches VMs, categories, and tags in parallel, then uses the
   * tag association API to attach resolved tags to each VM.
   */
  private async fetchVmsWithTags(): Promise<VmwareVm[]> {
    this.logger.debug('VMware: fetching VMs, categories, and tags in parallel');
    const [vms, categories, tags] = await Promise.all([
      this.vmwareGateway.listVms().then((v) => {
        this.logger.info('VMware VMs fetched', { vmCount: v.length });
        return v;
      }),
      this.vmwareGateway.listCategories().then((c) => {
        this.logger.debug('VMware categories fetched', { categoryCount: c.length });
        return c;
      }),
      this.vmwareGateway.listTags().then((t) => {
        this.logger.debug('VMware tags fetched', { tagCount: t.length });
        return t;
      }),
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
    this.logger.debug('VMware: fetching tag associations', { vmCount: vms.length });
    const vmIds = vms.map((vm) => vm.vmId);
    const associations =
      await this.vmwareGateway.getTagAssociationsForVms(vmIds);
    this.logger.debug('VMware tag associations fetched', { associationCount: associations.size });

    // Enrich each VM with its resolved tags
    for (const vm of vms) {
      const vmTags = associations.get(vm.vmId) ?? [];
      vm.tags = vmTags.map((t) => ({
        ...t,
        categoryName: tagMap.get(t.id)?.categoryName ?? 'Unknown',
      }));
    }

    this.logger.info('VMware data complete', {
      vmCount: vms.length,
      categoryCount: categories.length,
      tagCount: tags.length,
    });
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
  ): { matches: DeviceMatch[]; suppressedVmIds: Set<string> } {
    const matches: DeviceMatch[] = [];
    const suppressedVmIds = new Set<string>();
    const deviceMap = new Map(
      devices.map((d) => [d.id, d])
    );

    for (const vm of vms) {
      const override = this.mappingOverrides.getOverride(vm.vmId);
      if (!override) {
        continue;
      }

      // null deviceId means "suppress this VM from matching and unmatched reports"
      if (override.deviceId === null) {
        suppressedVmIds.add(vm.vmId);
        this.logger.debug('VM suppressed by mapping override (deviceId: null)', {
          vmId: vm.vmId,
          vmName: vm.name,
          comment: override.comment,
        });
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

    return { matches, suppressedVmIds };
  }

  /**
   * Write deduplicated missing tags to a CSV file.
   * Overwritten each run — the file shrinks to zero once all tags are
   * pre-created in the Vision One console.
   */
  private async writeMissingTagsCsv(missingTags: Set<string>): Promise<void> {
    const csvPath = path.resolve('./data/missing-tags.csv');
    const dir = path.dirname(csvPath);

    try {
      await fs.mkdir(dir, { recursive: true });

      const sorted = [...missingTags].sort();
      const lines = ['key,value'];
      for (const entry of sorted) {
        const [category, ...valueParts] = entry.split('::');
        const value = valueParts.join('::');
        // CSV-escape fields that contain commas or quotes
        const escKey = category.includes(',') || category.includes('"')
          ? `"${category.replace(/"/g, '""')}"` : category;
        const escVal = value.includes(',') || value.includes('"')
          ? `"${value.replace(/"/g, '""')}"` : value;
        lines.push(`${escKey},${escVal}`);
      }

      await fs.writeFile(csvPath, lines.join('\n') + '\n', 'utf-8');
    } catch (err) {
      this.logger.error(
        `Failed to write missing tags CSV to ${csvPath}`,
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }
}
