/**
 * VMware gateway implementation using the vSphere REST API.
 *
 * Implements the VmwareGateway port by translating domain
 * operations into vSphere REST calls via VmwareRestClient.
 */

import { VmwareGateway } from '../../domain/port/VmwareGateway';
import { VmwareVm } from '../../domain/model/VmwareVm';
import { VmwareCategory, VmwareTag } from '../../domain/model/VmwareTag';
import { VmwareAuthManager } from './VmwareAuthManager';
import { VmwareRestClient } from './VmwareRestClient';

/** Raw VM summary from GET /api/vcenter/vm */
interface VmSummary {
  vm: string;
  name: string;
  power_state: string;
  cpu_count?: number;
  memory_size_MiB?: number;
}

/** Detailed VM info from GET /api/vcenter/vm/{id} */
interface VmDetail {
  guest?: {
    host_name?: string;
  };
  nics?: Record<
    string,
    {
      backing?: { connection_state?: string };
      state?: string;
      mac_address?: string;
    }
  >;
}

/** Network interface info with IP addresses */
interface GuestNetworkInterface {
  ip_addresses?: Array<{ ip_address: string; prefix_length?: number }>;
  mac_address?: string;
}

/** Raw category from GET /api/cis/tagging/category/{id} */
interface RawCategory {
  id: string;
  name: string;
  description: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
  associable_types: string[];
}

/** Raw tag from GET /api/cis/tagging/tag/{id} */
interface RawTag {
  id: string;
  name: string;
  category_id: string;
  description?: string;
}

/** Tag association response entry */
interface TagAssociationEntry {
  object_id: { type: string; id: string };
  tag_ids: string[];
}

export class VmwareGatewayImpl implements VmwareGateway {
  private readonly authManager: VmwareAuthManager;
  private readonly client: VmwareRestClient;
  private categoryCache: Map<string, VmwareCategory> = new Map();
  private tagCache: Map<string, VmwareTag> = new Map();

  constructor(
    host: string,
    username: string,
    password: string,
    verifySsl: boolean = true
  ) {
    this.authManager = new VmwareAuthManager(host, username, password, verifySsl);
    this.client = new VmwareRestClient(this.authManager);
  }

  async connect(): Promise<void> {
    await this.authManager.authenticate();
  }

  async disconnect(): Promise<void> {
    await this.authManager.disconnect();
    this.categoryCache.clear();
    this.tagCache.clear();
  }

  async listVms(): Promise<VmwareVm[]> {
    const summaries = await this.client.get<VmSummary[]>('/api/vcenter/vm');

    if (!Array.isArray(summaries)) {
      return [];
    }

    const vms: VmwareVm[] = [];

    for (const summary of summaries) {
      const vm = await this.enrichVmWithGuestInfo(summary);
      vms.push(vm);
    }

    return vms;
  }

  async listCategories(): Promise<VmwareCategory[]> {
    const categoryIds = await this.client.get<string[]>(
      '/api/cis/tagging/category'
    );

    if (!Array.isArray(categoryIds)) {
      return [];
    }

    const categories: VmwareCategory[] = [];

    for (const id of categoryIds) {
      const raw = await this.client.get<RawCategory>(
        `/api/cis/tagging/category/${id}`
      );

      const category: VmwareCategory = {
        id: raw.id,
        name: raw.name,
        description: raw.description,
        cardinality: raw.cardinality,
        associableTypes: raw.associable_types ?? [],
      };

      categories.push(category);
      this.categoryCache.set(category.id, category);
    }

    return categories;
  }

  async listTags(): Promise<VmwareTag[]> {
    const tagIds = await this.client.get<string[]>('/api/cis/tagging/tag');

    if (!Array.isArray(tagIds)) {
      return [];
    }

    // Ensure categories are cached for name resolution.
    if (this.categoryCache.size === 0) {
      await this.listCategories();
    }

    const tags: VmwareTag[] = [];

    for (const id of tagIds) {
      const raw = await this.client.get<RawTag>(`/api/cis/tagging/tag/${id}`);

      const tag: VmwareTag = {
        id: raw.id,
        name: raw.name,
        categoryId: raw.category_id,
        categoryName: this.categoryCache.get(raw.category_id)?.name,
      };

      tags.push(tag);
      this.tagCache.set(tag.id, tag);
    }

    return tags;
  }

  async getTagAssociationsForVms(
    vmIds: string[]
  ): Promise<Map<string, VmwareTag[]>> {
    if (vmIds.length === 0) {
      return new Map();
    }

    // Ensure tags are cached for resolution.
    if (this.tagCache.size === 0) {
      await this.listTags();
    }

    const objectIds = vmIds.map((id) => ({
      type: 'VirtualMachine',
      id,
    }));

    const response = await this.client.post<TagAssociationEntry[]>(
      '/api/cis/tagging/tag-association?action=list-attached-tags-on-objects',
      { object_ids: objectIds }
    );

    const result = new Map<string, VmwareTag[]>();

    if (!Array.isArray(response)) {
      return result;
    }

    for (const entry of response) {
      const vmId = entry.object_id.id;
      const resolvedTags: VmwareTag[] = [];

      for (const tagId of entry.tag_ids) {
        const cached = this.tagCache.get(tagId);
        if (cached) {
          resolvedTags.push(cached);
        } else {
          // Fetch on cache miss and store for subsequent lookups.
          try {
            const raw = await this.client.get<RawTag>(
              `/api/cis/tagging/tag/${tagId}`
            );

            const tag: VmwareTag = {
              id: raw.id,
              name: raw.name,
              categoryId: raw.category_id,
              categoryName: this.categoryCache.get(raw.category_id)?.name,
            };

            this.tagCache.set(tag.id, tag);
            resolvedTags.push(tag);
          } catch {
            // Skip unresolvable tags rather than failing the whole batch.
          }
        }
      }

      result.set(vmId, resolvedTags);
    }

    return result;
  }

  /**
   * Fetch detailed guest information for a VM and merge it
   * with the basic summary data.
   */
  private async enrichVmWithGuestInfo(summary: VmSummary): Promise<VmwareVm> {
    let guestHostname: string | null = null;
    const ipAddresses: string[] = [];

    try {
      const detail = await this.client.get<VmDetail>(
        `/api/vcenter/vm/${summary.vm}`
      );

      guestHostname = detail.guest?.host_name ?? null;

      // Attempt to get IPs from guest networking info.
      const networkInterfaces = await this.fetchGuestNetworkInterfaces(
        summary.vm
      );

      for (const nic of networkInterfaces) {
        if (nic.ip_addresses) {
          for (const addr of nic.ip_addresses) {
            if (addr.ip_address && !ipAddresses.includes(addr.ip_address)) {
              ipAddresses.push(addr.ip_address);
            }
          }
        }
      }
    } catch {
      // Guest info may not be available (e.g. VMware Tools not installed).
      // Return what we have from the summary.
    }

    return {
      vmId: summary.vm,
      name: summary.name,
      powerState: summary.power_state,
      guestHostname,
      ipAddresses,
      tags: [],
    };
  }

  /**
   * Fetch guest network interfaces for a VM.
   * This endpoint requires VMware Tools to be running in the guest.
   */
  private async fetchGuestNetworkInterfaces(
    vmId: string
  ): Promise<GuestNetworkInterface[]> {
    try {
      const result = await this.client.get<GuestNetworkInterface[]>(
        `/api/vcenter/vm/${vmId}/guest/networking/interfaces`
      );
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }
}
