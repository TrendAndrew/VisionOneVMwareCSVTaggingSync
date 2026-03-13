/**
 * VMware gateway port (driven adapter interface).
 *
 * Abstracts all communication with the VMware vSphere API,
 * allowing the domain to remain infrastructure-agnostic.
 */

import { VmwareVm } from '../model/VmwareVm';
import { VmwareCategory, VmwareTag } from '../model/VmwareTag';

export interface VmwareGateway {
  /** Establish an authenticated session with vCenter. */
  connect(): Promise<void>;

  /** Terminate the vCenter session. */
  disconnect(): Promise<void>;

  /** Retrieve all virtual machines with guest info and IP addresses. */
  listVms(): Promise<VmwareVm[]>;

  /** Retrieve all tag categories. */
  listCategories(): Promise<VmwareCategory[]>;

  /** Retrieve all tags across all categories. */
  listTags(): Promise<VmwareTag[]>;

  /**
   * Fetch tag associations for a batch of VM identifiers.
   * @returns Map keyed by vmId, valued with the tags attached to that VM.
   */
  getTagAssociationsForVms(vmIds: string[]): Promise<Map<string, VmwareTag[]>>;
}
