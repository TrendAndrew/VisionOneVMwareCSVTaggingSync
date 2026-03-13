/**
 * Pure domain service that matches VMware VMs to Vision One endpoints.
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
import { VisionOneEndpoint } from '../model/VisionOneEndpoint';
import { EndpointMatch } from '../model/EndpointMatch';

export interface MatchingConfig {
  strategy: MatchStrategy;
  hostnameNormalization: HostnameNormalization;
  ipMatchMode: IpMatchMode;
  allowMultipleMatches: boolean;
}

interface RawMatch {
  vm: VmwareVm;
  endpoint: VisionOneEndpoint;
  matchedOn: MatchedOn;
  confidence: MatchConfidence;
}

export class MatchingService {
  constructor(private readonly config: MatchingConfig) {}

  /**
   * Match VMware VMs to Vision One endpoints using the configured strategy.
   *
   * @returns Array of endpoint matches with match metadata.
   */
  match(vms: VmwareVm[], endpoints: VisionOneEndpoint[]): EndpointMatch[] {
    if (vms.length === 0 || endpoints.length === 0) {
      return [];
    }

    let rawMatches: RawMatch[];

    switch (this.config.strategy) {
      case 'hostname':
        rawMatches = this.matchByHostname(vms, endpoints);
        break;

      case 'ip':
        rawMatches = this.matchByIp(vms, endpoints);
        break;

      case 'hostname-then-ip': {
        const hostnameMatches = this.matchByHostname(vms, endpoints);

        const matchedVmIds = new Set(hostnameMatches.map((m) => m.vm.vmId));
        const matchedEndpointGuids = new Set(
          hostnameMatches.map((m) => m.endpoint.agentGuid)
        );

        const unmatchedVms = vms.filter((vm) => !matchedVmIds.has(vm.vmId));
        const unmatchedEndpoints = endpoints.filter(
          (ep) => !matchedEndpointGuids.has(ep.agentGuid)
        );

        const ipMatches = this.matchByIp(unmatchedVms, unmatchedEndpoints);
        rawMatches = [...hostnameMatches, ...ipMatches];
        break;
      }

      case 'compound':
        rawMatches = this.matchByCompound(vms, endpoints);
        break;

      default:
        throw new Error(`Unknown match strategy: ${this.config.strategy as string}`);
    }

    const resolved = this.resolveConflicts(rawMatches);
    return resolved.map((m) => this.toEndpointMatch(m));
  }

  /**
   * Match VMs to endpoints by hostname comparison.
   */
  private matchByHostname(
    vms: VmwareVm[],
    endpoints: VisionOneEndpoint[]
  ): RawMatch[] {
    const matches: RawMatch[] = [];

    const endpointsByHostname = new Map<string, VisionOneEndpoint[]>();
    for (const ep of endpoints) {
      const normalized = this.normalizeHostname(ep.endpointName);
      if (!normalized) continue;
      const existing = endpointsByHostname.get(normalized) ?? [];
      existing.push(ep);
      endpointsByHostname.set(normalized, existing);
    }

    for (const vm of vms) {
      const vmHostname = vm.guestHostname ?? vm.name;
      if (!vmHostname) continue;

      const normalizedVm = this.normalizeHostname(vmHostname);
      if (!normalizedVm) continue;

      const matchedEndpoints = endpointsByHostname.get(normalizedVm);
      if (!matchedEndpoints) continue;

      const confidence = this.computeHostnameConfidence(vmHostname, matchedEndpoints);

      for (const ep of matchedEndpoints) {
        matches.push({
          vm,
          endpoint: ep,
          matchedOn: 'hostname',
          confidence,
        });
      }
    }

    return matches;
  }

  /**
   * Match VMs to endpoints by IP address comparison.
   */
  private matchByIp(
    vms: VmwareVm[],
    endpoints: VisionOneEndpoint[]
  ): RawMatch[] {
    const matches: RawMatch[] = [];

    for (const vm of vms) {
      if (vm.ipAddresses.length === 0) continue;

      for (const ep of endpoints) {
        if (ep.ipAddresses.length === 0) continue;

        if (this.ipsOverlap(vm.ipAddresses, ep.ipAddresses)) {
          matches.push({
            vm,
            endpoint: ep,
            matchedOn: 'ip',
            confidence: 'exact',
          });
        }
      }
    }

    return matches;
  }

  /**
   * Match VMs to endpoints requiring BOTH hostname AND IP to match.
   */
  private matchByCompound(
    vms: VmwareVm[],
    endpoints: VisionOneEndpoint[]
  ): RawMatch[] {
    const hostnameMatches = this.matchByHostname(vms, endpoints);
    const ipMatchSet = this.buildIpMatchSet(vms, endpoints);

    return hostnameMatches.filter((m) => {
      const key = `${m.vm.vmId}::${m.endpoint.agentGuid}`;
      return ipMatchSet.has(key);
    }).map((m) => ({
      ...m,
      matchedOn: 'both' as MatchedOn,
    }));
  }

  /**
   * Build a set of "vmId::agentGuid" keys for all IP-matched pairs.
   */
  private buildIpMatchSet(
    vms: VmwareVm[],
    endpoints: VisionOneEndpoint[]
  ): Set<string> {
    const set = new Set<string>();

    for (const vm of vms) {
      if (vm.ipAddresses.length === 0) continue;
      for (const ep of endpoints) {
        if (ep.ipAddresses.length === 0) continue;
        if (this.ipsOverlap(vm.ipAddresses, ep.ipAddresses)) {
          set.add(`${vm.vmId}::${ep.agentGuid}`);
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
  private ipsOverlap(vmIps: string[], endpointIps: string[]): boolean {
    switch (this.config.ipMatchMode) {
      case 'primary': {
        const vmPrimary = vmIps[0];
        const epPrimary = endpointIps[0];
        return vmPrimary !== undefined &&
               epPrimary !== undefined &&
               vmPrimary === epPrimary;
      }

      case 'any': {
        const epIpSet = new Set(endpointIps);
        return vmIps.some((ip) => epIpSet.has(ip));
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
    matchedEndpoints: VisionOneEndpoint[]
  ): MatchConfidence {
    if (this.config.hostnameNormalization === 'exact') {
      return 'exact';
    }

    for (const ep of matchedEndpoints) {
      if (ep.endpointName === vmHostname) {
        return 'exact';
      }
    }

    return 'normalized';
  }

  /**
   * Resolve conflicts when a VM or endpoint has multiple matches.
   *
   * If allowMultipleMatches is false, any VM or endpoint appearing in more
   * than one match is considered ambiguous and all its matches are dropped.
   */
  private resolveConflicts(matches: RawMatch[]): RawMatch[] {
    if (this.config.allowMultipleMatches) {
      return matches;
    }

    const byVm = new Map<string, RawMatch[]>();
    const byEndpoint = new Map<string, RawMatch[]>();

    for (const m of matches) {
      const vmGroup = byVm.get(m.vm.vmId) ?? [];
      vmGroup.push(m);
      byVm.set(m.vm.vmId, vmGroup);

      const epGroup = byEndpoint.get(m.endpoint.agentGuid) ?? [];
      epGroup.push(m);
      byEndpoint.set(m.endpoint.agentGuid, epGroup);
    }

    const ambiguousVms = new Set<string>();
    for (const [vmId, group] of byVm) {
      if (group.length > 1) {
        ambiguousVms.add(vmId);
      }
    }

    const ambiguousEndpoints = new Set<string>();
    for (const [agentGuid, group] of byEndpoint) {
      if (group.length > 1) {
        ambiguousEndpoints.add(agentGuid);
      }
    }

    return matches.filter(
      (m) =>
        !ambiguousVms.has(m.vm.vmId) &&
        !ambiguousEndpoints.has(m.endpoint.agentGuid)
    );
  }

  /**
   * Convert an internal RawMatch to the public EndpointMatch model.
   */
  private toEndpointMatch(raw: RawMatch): EndpointMatch {
    return {
      vmwareVm: raw.vm,
      visionOneEndpoint: raw.endpoint,
      matchedOn: raw.matchedOn,
      confidence: raw.confidence,
    };
  }
}
