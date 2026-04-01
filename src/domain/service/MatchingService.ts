/**
 * Pure domain service that matches VMware VMs to Vision One devices.
 *
 * Supports multiple matching strategies (hostname, IP, compound, hostname-then-ip)
 * with configurable hostname normalization and IP match modes.
 */

import {
  MatchStrategy,
  HostnameNormalization,
  IpMatchMode,
  MatchedOn,
  MatchConfidence,
} from '../../shared/types';
import { VmwareVm } from '../model/VmwareVm';
import { VisionOneDevice } from '../model/VisionOneEndpoint';
import { DeviceMatch } from '../model/EndpointMatch';

export interface MatchingConfig {
  strategy: MatchStrategy;
  hostnameNormalization: HostnameNormalization;
  ipMatchMode: IpMatchMode;
  allowMultipleMatches: boolean;
}

interface RawMatch {
  vm: VmwareVm;
  device: VisionOneDevice;
  matchedOn: MatchedOn;
  confidence: MatchConfidence;
}

export class MatchingService {
  constructor(private readonly config: MatchingConfig) {}

  /**
   * Match VMware VMs to Vision One devices using the configured strategy.
   *
   * @returns Array of device matches with match metadata.
   */
  match(vms: VmwareVm[], devices: VisionOneDevice[]): DeviceMatch[] {
    if (vms.length === 0 || devices.length === 0) {
      return [];
    }

    let rawMatches: RawMatch[];

    switch (this.config.strategy) {
      case 'hostname':
        rawMatches = this.matchByHostname(vms, devices);
        break;

      case 'ip':
        rawMatches = this.matchByIp(vms, devices);
        break;

      case 'hostname-then-ip': {
        const hostnameMatches = this.matchByHostname(vms, devices);

        const matchedVmIds = new Set(hostnameMatches.map((m) => m.vm.vmId));
        const matchedDeviceIds = new Set(
          hostnameMatches.map((m) => m.device.id)
        );

        const unmatchedVms = vms.filter((vm) => !matchedVmIds.has(vm.vmId));
        const unmatchedDevices = devices.filter(
          (device) => !matchedDeviceIds.has(device.id)
        );

        const ipMatches = this.matchByIp(unmatchedVms, unmatchedDevices);
        rawMatches = [...hostnameMatches, ...ipMatches];
        break;
      }

      case 'compound':
        rawMatches = this.matchByCompound(vms, devices);
        break;

      default:
        throw new Error(`Unknown match strategy: ${this.config.strategy as string}`);
    }

    const resolved = this.resolveConflicts(rawMatches);
    return resolved.map((m) => this.toDeviceMatch(m));
  }

  /**
   * Match VMs to devices by hostname comparison.
   */
  private matchByHostname(
    vms: VmwareVm[],
    devices: VisionOneDevice[]
  ): RawMatch[] {
    const matches: RawMatch[] = [];

    const devicesByHostname = new Map<string, VisionOneDevice[]>();
    for (const device of devices) {
      const normalized = this.normalizeHostname(device.deviceName);
      if (!normalized) continue;
      const existing = devicesByHostname.get(normalized) ?? [];
      existing.push(device);
      devicesByHostname.set(normalized, existing);
    }

    for (const vm of vms) {
      const vmHostname = vm.guestHostname ?? vm.name;
      if (!vmHostname) continue;

      const normalizedVm = this.normalizeHostname(vmHostname);
      if (!normalizedVm) continue;

      const matchedDevices = devicesByHostname.get(normalizedVm);
      if (!matchedDevices) continue;

      const confidence = this.computeHostnameConfidence(vmHostname, matchedDevices);

      for (const device of matchedDevices) {
        matches.push({
          vm,
          device,
          matchedOn: 'hostname',
          confidence,
        });
      }
    }

    return matches;
  }

  /**
   * Match VMs to devices by IP address comparison.
   */
  private matchByIp(
    vms: VmwareVm[],
    devices: VisionOneDevice[]
  ): RawMatch[] {
    const matches: RawMatch[] = [];

    for (const vm of vms) {
      if (vm.ipAddresses.length === 0) continue;

      for (const device of devices) {
        if (device.ipAddresses.length === 0) continue;

        if (this.ipsOverlap(vm.ipAddresses, device.ipAddresses)) {
          matches.push({
            vm,
            device,
            matchedOn: 'ip',
            confidence: 'exact',
          });
        }
      }
    }

    return matches;
  }

  /**
   * Match VMs to devices requiring BOTH hostname AND IP to match.
   */
  private matchByCompound(
    vms: VmwareVm[],
    devices: VisionOneDevice[]
  ): RawMatch[] {
    const hostnameMatches = this.matchByHostname(vms, devices);
    const ipMatchSet = this.buildIpMatchSet(vms, devices);

    return hostnameMatches.filter((m) => {
      const key = `${m.vm.vmId}::${m.device.id}`;
      return ipMatchSet.has(key);
    }).map((m) => ({
      ...m,
      matchedOn: 'both' as MatchedOn,
    }));
  }

  /**
   * Build a set of "vmId::deviceId" keys for all IP-matched pairs.
   */
  private buildIpMatchSet(
    vms: VmwareVm[],
    devices: VisionOneDevice[]
  ): Set<string> {
    const set = new Set<string>();

    for (const vm of vms) {
      if (vm.ipAddresses.length === 0) continue;
      for (const device of devices) {
        if (device.ipAddresses.length === 0) continue;
        if (this.ipsOverlap(vm.ipAddresses, device.ipAddresses)) {
          set.add(`${vm.vmId}::${device.id}`);
        }
      }
    }

    return set;
  }

  /**
   * Normalize a hostname according to the configured normalization mode.
   */
  private normalizeHostname(hostname: string): string {
    if (!hostname) return '';

    switch (this.config.hostnameNormalization) {
      case 'lowercase-no-domain': {
        const shortName = hostname.split('.')[0];
        return shortName.toLowerCase();
      }

      case 'lowercase':
        return hostname.toLowerCase();

      case 'exact':
        return hostname;

      default:
        throw new Error(
          `Unknown hostname normalization: ${this.config.hostnameNormalization as string}`
        );
    }
  }

  /**
   * Determine whether two sets of IPs overlap based on the configured IP match mode.
   */
  private ipsOverlap(vmIps: string[], deviceIps: string[]): boolean {
    switch (this.config.ipMatchMode) {
      case 'primary': {
        const vmPrimary = vmIps[0];
        const devicePrimary = deviceIps[0];
        return vmPrimary !== undefined &&
               devicePrimary !== undefined &&
               vmPrimary === devicePrimary;
      }

      case 'any': {
        const deviceIpSet = new Set(deviceIps);
        return vmIps.some((ip) => deviceIpSet.has(ip));
      }

      default:
        throw new Error(`Unknown IP match mode: ${this.config.ipMatchMode as string}`);
    }
  }

  /**
   * Compute the confidence level for a hostname match.
   * If the raw hostname was transformed during normalization, confidence is 'normalized'.
   */
  private computeHostnameConfidence(
    vmHostname: string,
    matchedDevices: VisionOneDevice[]
  ): MatchConfidence {
    if (this.config.hostnameNormalization === 'exact') {
      return 'exact';
    }

    for (const device of matchedDevices) {
      if (device.deviceName === vmHostname) {
        return 'exact';
      }
    }

    return 'normalized';
  }

  /**
   * Resolve conflicts when a VM or device has multiple matches.
   *
   * If allowMultipleMatches is false, any VM or device appearing in more
   * than one match is considered ambiguous and all its matches are dropped.
   */
  private resolveConflicts(matches: RawMatch[]): RawMatch[] {
    if (this.config.allowMultipleMatches) {
      return matches;
    }

    const byVm = new Map<string, RawMatch[]>();
    const byDevice = new Map<string, RawMatch[]>();

    for (const m of matches) {
      const vmGroup = byVm.get(m.vm.vmId) ?? [];
      vmGroup.push(m);
      byVm.set(m.vm.vmId, vmGroup);

      const deviceGroup = byDevice.get(m.device.id) ?? [];
      deviceGroup.push(m);
      byDevice.set(m.device.id, deviceGroup);
    }

    const ambiguousVms = new Set<string>();
    for (const [vmId, group] of byVm) {
      if (group.length > 1) {
        ambiguousVms.add(vmId);
      }
    }

    const ambiguousDevices = new Set<string>();
    for (const [deviceId, group] of byDevice) {
      if (group.length > 1) {
        ambiguousDevices.add(deviceId);
      }
    }

    return matches.filter(
      (m) =>
        !ambiguousVms.has(m.vm.vmId) &&
        !ambiguousDevices.has(m.device.id)
    );
  }

  /**
   * Convert an internal RawMatch to the public DeviceMatch model.
   */
  private toDeviceMatch(raw: RawMatch): DeviceMatch {
    return {
      vmwareVm: raw.vm,
      visionOneDevice: raw.device,
      matchedOn: raw.matchedOn,
      confidence: raw.confidence,
    };
  }
}
