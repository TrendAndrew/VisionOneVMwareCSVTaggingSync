/**
 * Sync state repository port.
 *
 * Persists synchronization state so that subsequent runs
 * can perform incremental (delta) updates.
 */

import { SyncState, SyncStateEntry } from '../model/SyncState';

export interface SyncStateRepository {
  /** Load the full sync state from persistent storage. */
  load(): Promise<SyncState>;

  /** Persist the full sync state. */
  save(state: SyncState): Promise<void>;

  /**
   * Retrieve a single entry by composite key (typically vmId:agentGuid).
   * @returns The entry, or null if not found.
   */
  getEntry(key: string): Promise<SyncStateEntry | null>;
}
