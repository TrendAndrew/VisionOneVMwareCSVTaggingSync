import { MatchingService, MatchingConfig } from '../../../src/domain/service/MatchingService';
import { VmwareVm } from '../../../src/domain/model/VmwareVm';
import { VisionOneEndpoint } from '../../../src/domain/model/VisionOneEndpoint';

// ── helpers ──

function makeVm(partial: Partial<VmwareVm> & { vmId: string }): VmwareVm {
  return {
    name: partial.vmId,
    powerState: 'POWERED_ON',
    guestHostname: null,
    ipAddresses: [],
    tags: [],
    ...partial,
  };
}

function makeEndpoint(
  partial: Partial<VisionOneEndpoint> & { agentGuid: string }
): VisionOneEndpoint {
  return {
    endpointName: partial.agentGuid,
    displayName: partial.agentGuid,
    ipAddresses: [],
    osName: 'Linux',
    customTags: [],
    ...partial,
  };
}

function defaultConfig(overrides: Partial<MatchingConfig> = {}): MatchingConfig {
  return {
    strategy: 'hostname',
    hostnameNormalization: 'lowercase-no-domain',
    ipMatchMode: 'any',
    allowMultipleMatches: false,
    ...overrides,
  };
}

// ── tests ──

describe('MatchingService', () => {
  // ── empty / no-match edge cases ──

  describe('empty inputs', () => {
    it('should return empty array when vms is empty', () => {
      const svc = new MatchingService(defaultConfig());
      const result = svc.match([], [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'host' })]);
      expect(result).toEqual([]);
    });

    it('should return empty array when endpoints is empty', () => {
      const svc = new MatchingService(defaultConfig());
      const result = svc.match([makeVm({ vmId: 'vm-1', guestHostname: 'host' })], []);
      expect(result).toEqual([]);
    });

    it('should return empty array when both arrays are empty', () => {
      const svc = new MatchingService(defaultConfig());
      expect(svc.match([], [])).toEqual([]);
    });
  });

  describe('no match found', () => {
    it('should return empty when no hostnames overlap', () => {
      const svc = new MatchingService(defaultConfig({ strategy: 'hostname' }));
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'alpha' })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'bravo' })];
      expect(svc.match(vms, eps)).toEqual([]);
    });

    it('should return empty when no IPs overlap', () => {
      const svc = new MatchingService(defaultConfig({ strategy: 'ip' }));
      const vms = [makeVm({ vmId: 'vm-1', ipAddresses: ['10.0.0.1'] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', ipAddresses: ['10.0.0.2'] })];
      expect(svc.match(vms, eps)).toEqual([]);
    });
  });

  // ── hostname strategy ──

  describe('hostname strategy', () => {
    it('should match by exact hostname when normalization is exact', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'hostname', hostnameNormalization: 'exact' })
      );
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'WebServer' })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'WebServer' })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
      expect(result[0].matchedOn).toBe('hostname');
      expect(result[0].confidence).toBe('exact');
    });

    it('should NOT match different cases when normalization is exact', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'hostname', hostnameNormalization: 'exact' })
      );
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'WebServer' })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'webserver' })];

      expect(svc.match(vms, eps)).toEqual([]);
    });

    it('should match with lowercase normalization ignoring case', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'hostname', hostnameNormalization: 'lowercase' })
      );
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'WebServer.Corp.Local' })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'webserver.corp.local' })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
      expect(result[0].matchedOn).toBe('hostname');
    });

    it('should match with lowercase-no-domain stripping domain and lowering case', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'hostname', hostnameNormalization: 'lowercase-no-domain' })
      );
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'DB-SERVER.corp.local' })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'db-server' })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe('normalized');
    });

    it('should report exact confidence when raw hostname matches endpoint name', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'hostname', hostnameNormalization: 'lowercase-no-domain' })
      );
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'web-server' })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'web-server' })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
      expect(result[0].confidence).toBe('exact');
    });

    it('should use vm.name as fallback when guestHostname is null', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'hostname', hostnameNormalization: 'lowercase-no-domain' })
      );
      const vms = [makeVm({ vmId: 'vm-1', name: 'APP-SERVER.corp.local', guestHostname: null })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'app-server' })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
      expect(result[0].vmwareVm.vmId).toBe('vm-1');
    });
  });

  // ── IP strategy ──

  describe('ip strategy', () => {
    it('should match when any IP overlaps in "any" mode', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'ip', ipMatchMode: 'any' })
      );
      const vms = [makeVm({ vmId: 'vm-1', ipAddresses: ['10.0.0.1', '10.0.0.2'] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', ipAddresses: ['10.0.0.2', '10.0.0.3'] })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
      expect(result[0].matchedOn).toBe('ip');
      expect(result[0].confidence).toBe('exact');
    });

    it('should NOT match when only non-primary IPs overlap in "primary" mode', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'ip', ipMatchMode: 'primary' })
      );
      const vms = [makeVm({ vmId: 'vm-1', ipAddresses: ['10.0.0.1', '10.0.0.2'] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', ipAddresses: ['10.0.0.9', '10.0.0.1'] })];

      // primary mode: vm primary=10.0.0.1, ep primary=10.0.0.9 -> no match
      expect(svc.match(vms, eps)).toEqual([]);
    });

    it('should match when primary IPs are equal in "primary" mode', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'ip', ipMatchMode: 'primary' })
      );
      const vms = [makeVm({ vmId: 'vm-1', ipAddresses: ['10.0.0.5'] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', ipAddresses: ['10.0.0.5', '10.0.0.6'] })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
    });

    it('should skip VMs with no IP addresses', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'ip', ipMatchMode: 'any' })
      );
      const vms = [makeVm({ vmId: 'vm-1', ipAddresses: [] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', ipAddresses: ['10.0.0.1'] })];

      expect(svc.match(vms, eps)).toEqual([]);
    });

    it('should skip endpoints with no IP addresses', () => {
      const svc = new MatchingService(
        defaultConfig({ strategy: 'ip', ipMatchMode: 'any' })
      );
      const vms = [makeVm({ vmId: 'vm-1', ipAddresses: ['10.0.0.1'] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', ipAddresses: [] })];

      expect(svc.match(vms, eps)).toEqual([]);
    });
  });

  // ── hostname-then-ip strategy ──

  describe('hostname-then-ip strategy', () => {
    it('should match by hostname first, then fallback to IP for unmatched', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname-then-ip',
          hostnameNormalization: 'lowercase-no-domain',
          ipMatchMode: 'any',
          allowMultipleMatches: true,
        })
      );

      const vms = [
        makeVm({ vmId: 'vm-1', guestHostname: 'host-a.corp.local', ipAddresses: ['10.0.0.1'] }),
        makeVm({ vmId: 'vm-2', guestHostname: 'unknown-host', ipAddresses: ['10.0.0.2'] }),
      ];
      const eps = [
        makeEndpoint({ agentGuid: 'ep-1', endpointName: 'host-a', ipAddresses: ['10.0.0.1'] }),
        makeEndpoint({ agentGuid: 'ep-2', endpointName: 'other-name', ipAddresses: ['10.0.0.2'] }),
      ];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(2);

      const hostnameMatch = result.find((m) => m.vmwareVm.vmId === 'vm-1');
      expect(hostnameMatch?.matchedOn).toBe('hostname');

      const ipMatch = result.find((m) => m.vmwareVm.vmId === 'vm-2');
      expect(ipMatch?.matchedOn).toBe('ip');
    });

    it('should not re-match already hostname-matched endpoints by IP', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname-then-ip',
          hostnameNormalization: 'lowercase-no-domain',
          ipMatchMode: 'any',
          allowMultipleMatches: true,
        })
      );

      const vms = [
        makeVm({ vmId: 'vm-1', guestHostname: 'server-a', ipAddresses: ['10.0.0.1'] }),
        makeVm({ vmId: 'vm-2', guestHostname: 'no-match', ipAddresses: ['10.0.0.1'] }),
      ];
      const eps = [
        makeEndpoint({ agentGuid: 'ep-1', endpointName: 'server-a', ipAddresses: ['10.0.0.1'] }),
      ];

      const result = svc.match(vms, eps);

      // vm-1 matches by hostname; ep-1 is consumed so vm-2 cannot match by IP
      expect(result).toHaveLength(1);
      expect(result[0].vmwareVm.vmId).toBe('vm-1');
      expect(result[0].matchedOn).toBe('hostname');
    });
  });

  // ── compound strategy ──

  describe('compound strategy', () => {
    it('should match only when BOTH hostname AND IP match', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'compound',
          hostnameNormalization: 'lowercase-no-domain',
          ipMatchMode: 'any',
          allowMultipleMatches: true,
        })
      );

      const vms = [
        makeVm({ vmId: 'vm-1', guestHostname: 'server-a.corp.local', ipAddresses: ['10.0.0.1'] }),
        makeVm({ vmId: 'vm-2', guestHostname: 'server-b', ipAddresses: ['10.0.0.2'] }),
      ];
      const eps = [
        makeEndpoint({ agentGuid: 'ep-1', endpointName: 'server-a', ipAddresses: ['10.0.0.1'] }),
        makeEndpoint({ agentGuid: 'ep-2', endpointName: 'server-b', ipAddresses: ['10.0.0.99'] }),
      ];

      const result = svc.match(vms, eps);

      // vm-1/ep-1: hostname matches AND IP matches -> included
      // vm-2/ep-2: hostname matches BUT IP does NOT -> excluded
      expect(result).toHaveLength(1);
      expect(result[0].matchedOn).toBe('both');
      expect(result[0].vmwareVm.vmId).toBe('vm-1');
    });

    it('should return empty when hostname matches but IP does not', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'compound',
          hostnameNormalization: 'exact',
          ipMatchMode: 'primary',
          allowMultipleMatches: true,
        })
      );

      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'server-x', ipAddresses: ['10.0.0.1'] })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'server-x', ipAddresses: ['10.0.0.2'] })];

      expect(svc.match(vms, eps)).toEqual([]);
    });
  });

  // ── conflict resolution ──

  describe('conflict resolution', () => {
    it('should drop ambiguous matches when allowMultipleMatches=false', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname',
          hostnameNormalization: 'lowercase-no-domain',
          allowMultipleMatches: false,
        })
      );

      // Two endpoints with the same short hostname -> VM matches both -> ambiguous
      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'server.corp.local' })];
      const eps = [
        makeEndpoint({ agentGuid: 'ep-1', endpointName: 'server.alpha.local' }),
        makeEndpoint({ agentGuid: 'ep-2', endpointName: 'server.beta.local' }),
      ];

      const result = svc.match(vms, eps);

      // vm-1 has two matches -> ambiguous VM -> all dropped
      expect(result).toEqual([]);
    });

    it('should drop matches when an endpoint matches multiple VMs (allowMultipleMatches=false)', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname',
          hostnameNormalization: 'lowercase-no-domain',
          allowMultipleMatches: false,
        })
      );

      const vms = [
        makeVm({ vmId: 'vm-1', guestHostname: 'server.alpha.local' }),
        makeVm({ vmId: 'vm-2', guestHostname: 'server.beta.local' }),
      ];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'server' })];

      const result = svc.match(vms, eps);

      // ep-1 matches both vms -> ambiguous endpoint -> dropped
      expect(result).toEqual([]);
    });

    it('should keep all matches when allowMultipleMatches=true', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname',
          hostnameNormalization: 'lowercase-no-domain',
          allowMultipleMatches: true,
        })
      );

      const vms = [makeVm({ vmId: 'vm-1', guestHostname: 'server.corp.local' })];
      const eps = [
        makeEndpoint({ agentGuid: 'ep-1', endpointName: 'server.alpha.local' }),
        makeEndpoint({ agentGuid: 'ep-2', endpointName: 'server.beta.local' }),
      ];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(2);
    });
  });

  // ── VMs with null guestHostname ──

  describe('null guestHostname', () => {
    it('should fall back to vm.name when guestHostname is null', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname',
          hostnameNormalization: 'lowercase-no-domain',
        })
      );

      const vms = [makeVm({ vmId: 'vm-1', name: 'MY-SERVER.corp.local', guestHostname: null })];
      const eps = [makeEndpoint({ agentGuid: 'ep-1', endpointName: 'my-server' })];

      const result = svc.match(vms, eps);

      expect(result).toHaveLength(1);
    });
  });

  // ── fixture-based integration-style test ──

  describe('fixture data', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fixtureVms: VmwareVm[] = require('../../fixtures/vmware-vms.json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fixtureEps: VisionOneEndpoint[] = require('../../fixtures/visionone-endpoints.json');

    it('should match expected pairs from fixture data using hostname strategy', () => {
      const svc = new MatchingService(
        defaultConfig({
          strategy: 'hostname',
          hostnameNormalization: 'lowercase-no-domain',
          allowMultipleMatches: true,
        })
      );

      const result = svc.match(fixtureVms, fixtureEps);

      // vm-101 (web-server-01.corp.local) -> ep agent-001 (web-server-01)
      // vm-102 (DB-SERVER-01.corp.local) -> ep agent-002 (db-server-01)
      // vm-103 has null guestHostname, name is app-server-01 -> ep agent-003 (app-server-01)
      // vm-104 (cache-server-01) -> ep agent-004 (cache-server-01)
      // vm-105 (unmatched-vm.corp.local) -> no match

      const matchedVmIds = result.map((m) => m.vmwareVm.vmId).sort();
      expect(matchedVmIds).toEqual(['vm-101', 'vm-102', 'vm-103', 'vm-104']);
    });
  });
});
