/**
 * VMware virtual machine domain model.
 *
 * Represents the subset of VM properties relevant to
 * endpoint matching and tag synchronization.
 */

import { VmwareTag } from './VmwareTag';

export interface VmwareVm {
  vmId: string;
  name: string;
  powerState: string;
  guestHostname: string | null;
  ipAddresses: string[];
  tags: VmwareTag[];
}
