import { DiffService, DiffConfig } from '../../../src/domain/service/DiffService';
import { EndpointMatch } from '../../../src/domain/model/EndpointMatch';
import { SyncStateEntry } from '../../../src/domain/model/SyncState';
import { VmwareVm } from '../../../src/domain/model/VmwareVm';
import { VisionOneEndpoint } from '../../../src/domain/model/VisionOneEndpoint';

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

function makeEndpoint(agentGuid: string): VisionOneEndpoint {
  return {
    agentGuid,
    endpointName: agentGuid,
    displayName: agentGuid,
    ipAddresses: [],
    osName: 'Linux',
    customTags: [],
  };
}

function makeMatch(vmId: string, agentGuid: string, tags: { name: string; categoryName?: string }[] = []): EndpointMatch {
  return {
    vmwareVm: makeVm(vmId, tags),
    visionOneEndpoint: makeEndpoint(agentGuid),
    matchedOn: 'hostname',
    confidence: 'exact',
  };
}

function makeSyncEntry(
  agentGuid: string,
  lastSyncedTags: string[],
  hash: string
): SyncStateEntry {
  return {
    vmId: 'vm-x',
    agentGuid,
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
  });
});
