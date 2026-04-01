/**
 * Mapping override port.
 *
 * Allows administrators to manually force VM-to-device mappings,
 * bypassing the automatic matching logic. Overrides take precedence
 * over any automatic match for the same VM.
 */

export interface MappingOverride {
  /** VMware VM MoRef ID (e.g., "vm-123"). */
  vmId: string;
  /** Optional human-readable VM name for documentation. */
  vmName?: string;
  /** Vision One ASRM device ID. */
  deviceId: string;
  /** Optional human-readable device name for documentation. */
  deviceName?: string;
  /** Optional admin note explaining the override. */
  comment?: string;
}

export interface MappingOverrideProvider {
  /** Load overrides from the backing store. */
  load(): Promise<MappingOverride[]>;
  /** Clear cache and re-read overrides (e.g., on SIGHUP). */
  reload(): Promise<MappingOverride[]>;
  /** Look up a forced mapping for a given VM. Returns null if none exists. */
  getOverride(vmId: string): MappingOverride | null;
}
