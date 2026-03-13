/**
 * Sync state domain models.
 *
 * Tracks which tags have been applied to which endpoints,
 * enabling incremental (delta) synchronization.
 */

export interface SyncStateEntry {
  vmId: string;
  agentGuid: string;
  lastSyncedTags: string[];
  lastSyncTimestamp: string;
  lastSyncHash: string;
}

export interface SyncState {
  entries: Map<string, SyncStateEntry>;
  lastFullSyncTimestamp: string | null;
}
