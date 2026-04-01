/**
 * Sync state domain models.
 *
 * Tracks which tags have been applied to which devices,
 * enabling incremental (delta) synchronization.
 */

export interface SyncStateEntry {
  vmId: string;
  deviceId: string;
  lastSyncedTags: string[];
  lastSyncTimestamp: string;
  lastSyncHash: string;
}

export interface SyncState {
  entries: Map<string, SyncStateEntry>;
  lastFullSyncTimestamp: string | null;
}
