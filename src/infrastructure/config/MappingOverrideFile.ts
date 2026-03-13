/**
 * File-based mapping override provider.
 *
 * Reads manual VM-to-endpoint mapping overrides from a JSON file.
 * The file format is:
 * {
 *   "description": "...",
 *   "overrides": [
 *     { "vmId": "vm-123", "agentGuid": "...", ... }
 *   ]
 * }
 *
 * Supports hot-reload via the reload() method (called on SIGHUP).
 */

import fs from 'fs/promises';
import path from 'path';
import {
  MappingOverrideProvider,
  MappingOverride,
} from '../../domain/port/MappingOverrideProvider';

/** Shape of the JSON file on disk. */
interface OverrideFileSchema {
  description?: string;
  instructions?: string;
  overrides: Array<Record<string, unknown>>;
}

export class MappingOverrideFile implements MappingOverrideProvider {
  private overrides: Map<string, MappingOverride> = new Map();

  constructor(
    private readonly filePath: string = './config/mapping-overrides.json'
  ) {}

  /**
   * Read the overrides file and populate the internal lookup map.
   * If the file does not exist, returns an empty array without error.
   * Each entry is validated to ensure vmId and agentGuid are present.
   */
  async load(): Promise<MappingOverride[]> {
    const resolvedPath = path.resolve(this.filePath);

    let rawContent: string;
    try {
      rawContent = await fs.readFile(resolvedPath, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return [];
      }
      throw new Error(
        `Failed to read mapping overrides file at ${resolvedPath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    let parsed: OverrideFileSchema;
    try {
      parsed = JSON.parse(rawContent) as OverrideFileSchema;
    } catch (err) {
      throw new Error(
        `Failed to parse mapping overrides JSON at ${resolvedPath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const rawOverrides = parsed.overrides;
    if (!Array.isArray(rawOverrides)) {
      throw new Error(
        `Mapping overrides file at ${resolvedPath} must contain an "overrides" array`
      );
    }

    const validated: MappingOverride[] = [];

    for (let i = 0; i < rawOverrides.length; i++) {
      const entry = rawOverrides[i];
      const vmId = entry.vmId as string | undefined;
      const agentGuid = entry.agentGuid as string | undefined;

      if (!vmId || typeof vmId !== 'string') {
        throw new Error(
          `Mapping override at index ${i} is missing a valid "vmId" string`
        );
      }

      if (!agentGuid || typeof agentGuid !== 'string') {
        throw new Error(
          `Mapping override at index ${i} is missing a valid "agentGuid" string`
        );
      }

      const override: MappingOverride = {
        vmId,
        agentGuid,
        vmName: typeof entry.vmName === 'string' ? entry.vmName : undefined,
        endpointName:
          typeof entry.endpointName === 'string'
            ? entry.endpointName
            : undefined,
        comment:
          typeof entry.comment === 'string' ? entry.comment : undefined,
      };

      validated.push(override);
      this.overrides.set(vmId, override);
    }

    return validated;
  }

  /**
   * Clear the cache and re-read from disk.
   * Intended to be called on SIGHUP for live reload.
   */
  async reload(): Promise<MappingOverride[]> {
    this.overrides.clear();
    return this.load();
  }

  /**
   * Look up a forced mapping for a VM by its VMware ID.
   */
  getOverride(vmId: string): MappingOverride | null {
    return this.overrides.get(vmId) ?? null;
  }
}
