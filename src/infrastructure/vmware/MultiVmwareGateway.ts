/**
 * Aggregating VMware gateway for multi-vCenter environments.
 *
 * Wraps multiple VmwareGatewayImpl instances (one per vCenter host)
 * and presents a unified view of all VMs, categories, tags, and
 * tag associations across all connected vCenters.
 *
 * Each VM is stamped with its sourceVcenter so that logs, unmatched
 * reports, and mapping overrides can identify which vCenter it belongs to.
 */

import { VmwareGateway } from '../../domain/port/VmwareGateway';
import { VmwareVm } from '../../domain/model/VmwareVm';
import { VmwareCategory, VmwareTag } from '../../domain/model/VmwareTag';
import { VmwareGatewayImpl } from './VmwareGatewayImpl';
import { Logger } from '../../domain/port/Logger';
import { VmwareHostConfig } from '../config/ConfigSchema';

export class MultiVmwareGateway implements VmwareGateway {
  private readonly gateways: Array<{ label: string; gateway: VmwareGatewayImpl }>;

  constructor(
    hosts: VmwareHostConfig[],
    private readonly logger: Logger
  ) {
    this.gateways = hosts.map((h) => ({
      label: h.label ?? h.host,
      gateway: new VmwareGatewayImpl(
        h.host,
        h.username,
        h.password,
        h.verifySsl
      ),
    }));

    logger.info('Multi-vCenter gateway initialised', {
      vCenterCount: this.gateways.length,
      hosts: this.gateways.map((g) => g.label),
    });
  }

  async connect(): Promise<void> {
    const results = await Promise.allSettled(
      this.gateways.map(async ({ label, gateway }) => {
        this.logger.debug(`Connecting to vCenter: ${label}`);
        await gateway.connect();
        this.logger.info(`Connected to vCenter: ${label}`);
      })
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length === this.gateways.length) {
      throw new Error(
        'Failed to connect to all vCenter hosts: ' +
          failures.map((f) => (f as PromiseRejectedResult).reason).join('; ')
      );
    }

    if (failures.length > 0) {
      this.logger.warn(
        `Connected to ${results.length - failures.length}/${results.length} vCenters. ` +
          `${failures.length} failed — sync will proceed with available hosts.`
      );
    }
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(
      this.gateways.map(({ gateway }) => gateway.disconnect())
    );
  }

  async listVms(): Promise<VmwareVm[]> {
    const allVms: VmwareVm[] = [];

    const results = await Promise.allSettled(
      this.gateways.map(async ({ label, gateway }) => {
        const vms = await gateway.listVms();
        // Stamp each VM with its source and prefix vmId to avoid collisions
        return vms.map((vm) => ({
          ...vm,
          vmId: this.qualifiedVmId(label, vm.vmId),
          sourceVcenter: label,
        }));
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allVms.push(...result.value);
      } else {
        this.logger.error(
          `Failed to list VMs from vCenter "${this.gateways[i].label}"`,
          result.reason instanceof Error ? result.reason : new Error(String(result.reason))
        );
      }
    }

    this.logger.info('VMs fetched from all vCenters', {
      totalVms: allVms.length,
      perHost: this.gateways.map((g, i) => ({
        label: g.label,
        count: results[i].status === 'fulfilled'
          ? (results[i] as PromiseFulfilledResult<VmwareVm[]>).value.length
          : 'error',
      })),
    });

    return allVms;
  }

  async listCategories(): Promise<VmwareCategory[]> {
    const allCategories: VmwareCategory[] = [];
    const seen = new Set<string>();

    const results = await Promise.allSettled(
      this.gateways.map(({ gateway }) => gateway.listCategories())
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const cat of result.value) {
          // Deduplicate by name (categories with same name across vCenters are logically the same)
          if (!seen.has(cat.name)) {
            seen.add(cat.name);
            allCategories.push(cat);
          }
        }
      }
    }

    return allCategories;
  }

  async listTags(): Promise<VmwareTag[]> {
    const allTags: VmwareTag[] = [];
    const seen = new Set<string>();

    const results = await Promise.allSettled(
      this.gateways.map(({ gateway }) => gateway.listTags())
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const tag of result.value) {
          // Deduplicate by category+name
          const key = `${tag.categoryName ?? tag.categoryId}:${tag.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            allTags.push(tag);
          }
        }
      }
    }

    return allTags;
  }

  async getTagAssociationsForVms(
    vmIds: string[]
  ): Promise<Map<string, VmwareTag[]>> {
    const result = new Map<string, VmwareTag[]>();

    // Group qualified vmIds by their source vCenter
    const vmIdsByHost = new Map<string, string[]>();
    for (const qualifiedId of vmIds) {
      const { label, rawId } = this.parseQualifiedVmId(qualifiedId);
      if (!vmIdsByHost.has(label)) {
        vmIdsByHost.set(label, []);
      }
      vmIdsByHost.get(label)!.push(rawId);
    }

    // Fetch associations from each relevant vCenter
    const fetchPromises = Array.from(vmIdsByHost.entries()).map(
      async ([label, rawIds]) => {
        const entry = this.gateways.find((g) => g.label === label);
        if (!entry) return;

        try {
          const associations = await entry.gateway.getTagAssociationsForVms(rawIds);
          // Re-key results with qualified IDs
          for (const [rawId, tags] of associations) {
            result.set(this.qualifiedVmId(label, rawId), tags);
          }
        } catch (err) {
          this.logger.error(
            `Failed to fetch tag associations from vCenter "${label}"`,
            err instanceof Error ? err : new Error(String(err))
          );
        }
      }
    );

    await Promise.allSettled(fetchPromises);
    return result;
  }

  /**
   * Create a qualified VM ID that includes the vCenter label.
   * Format: "label::vmId" (e.g., "vcenter-dc1::vm-123")
   */
  private qualifiedVmId(label: string, rawId: string): string {
    return `${label}::${rawId}`;
  }

  /**
   * Parse a qualified VM ID back into its label and raw ID.
   */
  private parseQualifiedVmId(qualifiedId: string): { label: string; rawId: string } {
    const separatorIndex = qualifiedId.indexOf('::');
    if (separatorIndex === -1) {
      // Backward compat: if no separator, assume first (only) gateway
      return {
        label: this.gateways[0]?.label ?? 'unknown',
        rawId: qualifiedId,
      };
    }
    return {
      label: qualifiedId.substring(0, separatorIndex),
      rawId: qualifiedId.substring(separatorIndex + 2),
    };
  }
}
