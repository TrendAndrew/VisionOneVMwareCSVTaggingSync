import { DiffService, DiffConfig } from '../../../src/domain/service/DiffService';
import { DeviceMatch } from '../../../src/domain/model/EndpointMatch';
import { SyncStateEntry } from '../../../src/domain/model/SyncState';
import { VmwareVm } from '../../../src/domain/model/VmwareVm';
import { VisionOneDevice } from '../../../src/domain/model/VisionOneEndpoint';

// ── helpers ──

function makeVm(vmId: string, tags: { name: string; categoryName?: string }[] = []): VmwareVm {
  return {
    vmId,
    name: vmId,
    powerState: 'POWERED_ON',
    guestHostname: null,
    ipAddresses: [],
    tags: tags.map((t, i) => ({
      id: `tag-${i}`,
      name: t.name,
      categoryId: `cat-${i}`,
      categoryName: t.categoryName,
    })),
  };
}

function makeDevice(deviceId: string): VisionOneDevice {
  return {
    id: deviceId,
    deviceName: deviceId,
    ipAddresses: [],
    osName: 'Linux',
    assetCustomTagIds: [],
  };
}

function makeMatch(vmId: string, deviceId: string, tags: { name: string; categoryName?: string }[] = []): DeviceMatch {
  return {
    vmwareVm: makeVm(vmId, tags),
    visionOneDevice: makeDevice(deviceId),
    matchedOn: 'hostname',
    confidence: 'exact',
  };
}

function makeSyncEntry(
  deviceId: string,
  lastSyncedTags: string[],
  hash: string
): SyncStateEntry {
  return {
    vmId: 'vm-x',
    deviceId,
    lastSyncedTags,
    lastSyncTimestamp: new Date().toISOString(),
    lastSyncHash: hash,
  };
}

function defaultConfig(overrides: Partial<DiffConfig> = {}): DiffConfig {
  return {
    removeOrphanedTags: true,
    ...overrides,
  };
}

// ── tests ──

describe('DiffService', () => {
  describe('computeTagHash', () => {
    it('should produce consistent hashes for the same tags regardless of order', () => {
      const svc = new DiffService(defaultConfig());
      const hash1 = svc.computeTagHash(['tagA', 'tagB', 'tagC']);
      const hash2 = svc.computeTagHash(['tagC', 'tagA', 'tagB']);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tag sets', () => {
      const svc = new DiffService(defaultConfig());
      const hash1 = svc.computeTagHash(['tagA', 'tagB']);
      const hash2 = svc.computeTagHash(['tagA', 'tagC']);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce a hex string', () => {
      const svc = new DiffService(defaultConfig());
      const hash = svc.computeTagHash(['tag']);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('computeDiffs', () => {
    it('should treat first sync (no sync state entry) as all additions', () => {
      const svc = new DiffService(defaultConfig());
      const match = makeMatch('vm-1', 'ep-1');
      const desiredTags = new Map([['ep-1', ['env:prod', 'role:web']]]);

      const diffs = svc.computeDiffs([match], new Map(), new Set(), desiredTags);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual(['env:prod', 'role:web']);
      expect(diffs[0].tagsToRemove).toEqual([]);
    });

    it('should skip (return empty diff) when hash has not changed', () => {
      const svc = new DiffService(defaultConfig());
      const desiredTags = ['env:prod', 'role:web'];
      const hash = svc.computeTagHash(desiredTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', desiredTags, hash)]]);
      const desiredMap = new Map([['ep-1', desiredTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toEqual([]);
    });

    it('should detect tags to add when new tags appear', () => {
      const svc = new DiffService(defaultConfig());
      const oldTags = ['env:prod'];
      const newTags = ['env:prod', 'role:web'];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual(['role:web']);
      expect(diffs[0].tagsToRemove).toEqual([]);
    });

    it('should detect tags to remove when removeOrphanedTags=true', () => {
      const svc = new DiffService(defaultConfig({ removeOrphanedTags: true }));
      const oldTags = ['env:prod', 'role:web'];
      const newTags = ['env:prod'];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual([]);
      expect(diffs[0].tagsToRemove).toEqual(['role:web']);
    });

    it('should NOT remove tags when removeOrphanedTags=false', () => {
      const svc = new DiffService(defaultConfig({ removeOrphanedTags: false }));
      const oldTags = ['env:prod', 'role:web'];
      const newTags = ['env:prod'];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      // Hash changed but no tags to add and removeOrphanedTags=false -> no tagsToRemove
      // Since only removal and no addition, diff should be null (filtered out)
      expect(diffs).toEqual([]);
    });

    it('should handle mixed adds and removes in one diff', () => {
      const svc = new DiffService(defaultConfig({ removeOrphanedTags: true }));
      const oldTags = ['env:prod', 'role:web'];
      const newTags = ['env:staging', 'role:web', 'tier:frontend'];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toContain('env:staging');
      expect(diffs[0].tagsToAdd).toContain('tier:frontend');
      expect(diffs[0].tagsToRemove).toEqual(['env:prod']);
    });

    it('should use deriveDesiredTags fallback when desiredTagsByAgentGuid is not provided', () => {
      const svc = new DiffService(defaultConfig());
      const match = makeMatch('vm-1', 'ep-1', [
        { name: 'Production', categoryName: 'Environment' },
        { name: 'Web', categoryName: 'Role' },
      ]);

      const diffs = svc.computeDiffs([match], new Map(), new Set());

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual(['Environment/Production', 'Role/Web']);
    });

    it('should skip tags without categoryName in deriveDesiredTags', () => {
      const svc = new DiffService(defaultConfig());
      const match = makeMatch('vm-1', 'ep-1', [
        { name: 'Production', categoryName: 'Environment' },
        { name: 'Orphan' }, // no categoryName
      ]);

      const diffs = svc.computeDiffs([match], new Map(), new Set());

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual(['Environment/Production']);
    });

    it('should handle multiple matches independently', () => {
      const svc = new DiffService(defaultConfig());
      const match1 = makeMatch('vm-1', 'ep-1');
      const match2 = makeMatch('vm-2', 'ep-2');
      const desiredMap = new Map([
        ['ep-1', ['tagA']],
        ['ep-2', ['tagB']],
      ]);

      const diffs = svc.computeDiffs([match1, match2], new Map(), new Set(), desiredMap);

      expect(diffs).toHaveLength(2);
    });

    it('should only remove tags matching orphanRemovalPrefix', () => {
      const svc = new DiffService(defaultConfig({
        removeOrphanedTags: true,
        orphanRemovalPrefix: 'vmware:',
      }));
      const oldTags = ['vmware:Environment/Prod', 'manual:CustomLabel', 'vmware:Role/Web'];
      const newTags = ['vmware:Environment/Prod'];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      // vmware:Role/Web should be removed (matches prefix)
      expect(diffs[0].tagsToRemove).toContain('vmware:Role/Web');
      // manual:CustomLabel should NOT be removed (wrong prefix)
      expect(diffs[0].tagsToRemove).not.toContain('manual:CustomLabel');
    });

    it('should only remove tags in orphanRemovalAllowlist when set', () => {
      const allowlist = new Set(['vmware:Environment/Staging', 'vmware:Role/Web']);
      const svc = new DiffService(defaultConfig({
        removeOrphanedTags: true,
        orphanRemovalPrefix: 'vmware:',
        orphanRemovalAllowlist: allowlist,
      }));
      const oldTags = ['vmware:Environment/Staging', 'vmware:Role/Web', 'vmware:Team/Infra'];
      const newTags: string[] = [];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      // Only allowlisted tags are removed
      expect(diffs[0].tagsToRemove).toContain('vmware:Environment/Staging');
      expect(diffs[0].tagsToRemove).toContain('vmware:Role/Web');
      // vmware:Team/Infra has correct prefix but is NOT in allowlist
      expect(diffs[0].tagsToRemove).not.toContain('vmware:Team/Infra');
    });

    it('should allow all removals when no prefix or allowlist is set', () => {
      const svc = new DiffService(defaultConfig({
        removeOrphanedTags: true,
      }));
      const oldTags = ['anyTag', 'anotherTag'];
      const newTags: string[] = [];
      const oldHash = svc.computeTagHash(oldTags);

      const match = makeMatch('vm-1', 'ep-1');
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newTags]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToRemove).toEqual(['anyTag', 'anotherTag']);
    });
  });

  describe('computeDiffs with live tag state (drift detection)', () => {
    it('should detect drift when tag removed manually in V1', () => {
      const svc = new DiffService(defaultConfig());
      const desiredTags = ['env:prod', 'role:web'];
      const hash = svc.computeTagHash(desiredTags);

      const match = makeMatch('vm-1', 'ep-1');
      // Sync state says both tags were applied
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', desiredTags, hash)]]);
      const desiredMap = new Map([['ep-1', desiredTags]]);
      // But live device only has one tag (someone removed role:web manually)
      const liveMap = new Map([['ep-1', ['env:prod']]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap, liveMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual(['role:web']);
      expect(diffs[0].tagsToRemove).toEqual([]);
    });

    it('should detect drift when managed tag still on device but no longer desired', () => {
      const svc = new DiffService(defaultConfig({ removeOrphanedTags: true }));
      const oldTags = ['env:prod', 'role:web'];
      const oldHash = svc.computeTagHash(oldTags);
      const newDesired = ['env:prod'];

      const match = makeMatch('vm-1', 'ep-1');
      // Sync state says we applied both tags
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newDesired]]);
      // Live device still has both (role:web is still present)
      const liveMap = new Map([['ep-1', ['env:prod', 'role:web']]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap, liveMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual([]);
      expect(diffs[0].tagsToRemove).toEqual(['role:web']);
    });

    it('should skip device when live state matches desired even if sync state is stale', () => {
      const svc = new DiffService(defaultConfig());
      const desiredTags = ['env:prod', 'role:web'];
      const hash = svc.computeTagHash(desiredTags);

      const match = makeMatch('vm-1', 'ep-1');
      // Sync state matches desired hash
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', desiredTags, hash)]]);
      const desiredMap = new Map([['ep-1', desiredTags]]);
      // Live device also has the right tags
      const liveMap = new Map([['ep-1', ['env:prod', 'role:web']]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap, liveMap);

      expect(diffs).toEqual([]);
    });

    it('should not try to remove tags already gone from live device', () => {
      const svc = new DiffService(defaultConfig({ removeOrphanedTags: true }));
      const oldTags = ['env:prod', 'role:web'];
      const oldHash = svc.computeTagHash(oldTags);
      const newDesired = ['env:prod'];

      const match = makeMatch('vm-1', 'ep-1');
      // Sync state says we managed both tags
      const syncState = new Map([['ep-1', makeSyncEntry('ep-1', oldTags, oldHash)]]);
      const desiredMap = new Map([['ep-1', newDesired]]);
      // But role:web is already gone from live device
      const liveMap = new Map([['ep-1', ['env:prod']]]);

      const diffs = svc.computeDiffs([match], syncState, new Set(), desiredMap, liveMap);

      // Live state already matches desired -- no action needed
      expect(diffs).toEqual([]);
    });

    it('should be backward compatible when liveTagNames not provided', () => {
      const svc = new DiffService(defaultConfig());
      const match = makeMatch('vm-1', 'ep-1');
      const desiredMap = new Map([['ep-1', ['env:prod', 'role:web']]]);

      // No liveMap passed -- should fall back to sync-state-only behavior
      const diffs = svc.computeDiffs([match], new Map(), new Set(), desiredMap);

      expect(diffs).toHaveLength(1);
      expect(diffs[0].tagsToAdd).toEqual(['env:prod', 'role:web']);
    });

    it('should detect first sync with live tags present on device', () => {
      const svc = new DiffService(defaultConfig());
      const desiredTags = ['env:prod', 'role:web'];

      const match = makeMatch('vm-1', 'ep-1');
      // No sync state (first run)
      const desiredMap = new Map([['ep-1', desiredTags]]);
      // But device already has env:prod (perhaps added manually)
      const liveMap = new Map([['ep-1', ['env:prod']]]);

      const diffs = svc.computeDiffs([match], new Map(), new Set(), desiredMap, liveMap);

      expect(diffs).toHaveLength(1);
      // Only role:web needs to be added; env:prod is already there
      expect(diffs[0].tagsToAdd).toEqual(['role:web']);
      expect(diffs[0].tagsToRemove).toEqual([]);
    });
  });
});
