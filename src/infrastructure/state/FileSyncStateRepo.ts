/**
 * JSON file-based sync state persistence.
 *
 * Stores the SyncState as a JSON file, serializing the entries Map
 * to an array of [key, value] tuples for JSON compatibility.
 * Writes are atomic (write to temp file, then rename).
 */

import fs from 'fs/promises';
import path from 'path';
import { SyncStateRepository } from '../../domain/port/SyncStateRepository';
import { SyncState, SyncStateEntry } from '../../domain/model/SyncState';
import { SyncStateError } from '../../shared/errors';

/** JSON-serializable shape of the state file. */
interface SerializedSyncState {
  entries: Array<[string, SyncStateEntry]>;
  lastFullSyncTimestamp: string | null;
}

export class FileSyncStateRepo implements SyncStateRepository {
  constructor(
    private readonly filePath: string,
    private readonly backupOnWrite: boolean = true
  ) {}

  async load(): Promise<SyncState> {
    const resolvedPath = path.resolve(this.filePath);

    try {
      await fs.access(resolvedPath);
    } catch {
      return this.emptyState();
    }

    try {
      const raw = await fs.readFile(resolvedPath, 'utf-8');
      const parsed: SerializedSyncState = JSON.parse(raw);

      return {
        entries: new Map(parsed.entries ?? []),
        lastFullSyncTimestamp: parsed.lastFullSyncTimestamp ?? null,
      };
    } catch (error) {
      throw new SyncStateError(
        `Failed to load sync state from ${resolvedPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async save(state: SyncState): Promise<void> {
    const resolvedPath = path.resolve(this.filePath);
    const dir = path.dirname(resolvedPath);

    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      throw new SyncStateError(
        `Failed to create directory ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : undefined
      );
    }

    if (this.backupOnWrite) {
      await this.createBackup(resolvedPath);
    }

    const serialized: SerializedSyncState = {
      entries: Array.from(state.entries.entries()),
      lastFullSyncTimestamp: state.lastFullSyncTimestamp,
    };

    const json = JSON.stringify(serialized, null, 2);
    const tempPath = `${resolvedPath}.tmp.${Date.now()}`;

    try {
      await fs.writeFile(tempPath, json, 'utf-8');
      await fs.rename(tempPath, resolvedPath);
    } catch (error) {
      // Clean up temp file on failure.
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors.
      }

      throw new SyncStateError(
        `Failed to save sync state to ${resolvedPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : undefined
      );
    }
  }

  async getEntry(key: string): Promise<SyncStateEntry | null> {
    const state = await this.load();
    return state.entries.get(key) ?? null;
  }

  /**
   * Create a backup of the existing state file before overwriting.
   */
  private async createBackup(filePath: string): Promise<void> {
    try {
      await fs.access(filePath);
      const backupPath = `${filePath}.bak`;
      await fs.copyFile(filePath, backupPath);
    } catch {
      // No existing file to back up; that's fine.
    }
  }

  private emptyState(): SyncState {
    return {
      entries: new Map(),
      lastFullSyncTimestamp: null,
    };
  }
}
