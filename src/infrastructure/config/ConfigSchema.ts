/**
 * Configuration schema and validation using Zod.
 *
 * Defines the shape of the application configuration with
 * sensible defaults and strict validation rules.
 */

import { z } from 'zod';

/** Schema for a single vCenter host configuration. */
export const vmwareHostSchema = z.object({
  /** Unique label for this vCenter (used in logs and reports). Defaults to host value. */
  label: z.string().optional(),
  host: z.string().min(1, 'VMware host is required'),
  username: z.string().min(1, 'VMware username is required'),
  password: z.string().min(1, 'VMware password is required'),
  verifySsl: z.boolean().default(true),
  categoryFilter: z.array(z.string()).default([]),
  tagFilter: z.array(z.string()).default([]),
  vmFilter: z
    .object({
      powerStates: z.array(z.string()).default(['POWERED_ON']),
      namePattern: z.string().nullable().default(null),
    })
    .default({}),
  requestTimeoutMs: z.number().positive().default(30000),
});

export type VmwareHostConfig = z.infer<typeof vmwareHostSchema>;

export const configSchema = z.object({
  /**
   * VMware configuration. Accepts either:
   *  - A single host object (backward compatible)
   *  - An array of host objects (multi-vCenter)
   *
   * Internally normalised to an array via vmwareHosts.
   */
  vmware: z.union([vmwareHostSchema, z.array(vmwareHostSchema).min(1)]),

  visionone: z.object({
    apiToken: z.string().min(1, 'Vision One API token is required'),
    region: z.enum(['us', 'eu', 'jp', 'sg', 'au', 'in', 'mea'], {
      errorMap: () => ({
        message:
          'Vision One region must be one of: us, eu, jp, sg, au, in, mea',
      }),
    }),
    devicePageSize: z.number().positive().default(200),
    requestTimeoutMs: z.number().positive().default(30000),
    rateLimitDelayMs: z.number().nonnegative().default(100),
  }),

  sync: z
    .object({
      intervalMinutes: z.number().min(1).default(15),
      batchSize: z.number().min(1).default(50),
      maxRetries: z.number().nonnegative().default(3),
      retryDelayMs: z.number().nonnegative().default(2000),
      removeOrphanedTags: z.boolean().default(false),
      /**
       * File path to a JSON array of exact tag names eligible for orphan removal.
       * When set, only tags in this file can be removed -- everything else is
       * left untouched. Useful for loading a catalog of VMware-managed tags.
       * If not set, falls back to prefix-based filtering using tagPrefix.
       */
      orphanRemovalAllowlistFile: z.string().nullable().default(null),
      tagPrefix: z.string().default('vmware:'),
      categorySeparator: z.string().default('/'),
      maxTagNameLength: z.number().positive().default(64),
    })
    .default({}),

  matching: z
    .object({
      strategy: z
        .enum(['hostname', 'ip', 'hostname-then-ip', 'compound'])
        .default('hostname-then-ip'),
      hostnameNormalization: z
        .enum(['lowercase-no-domain', 'lowercase', 'exact'])
        .default('lowercase-no-domain'),
      ipMatchMode: z.enum(['any', 'primary']).default('any'),
      allowMultipleMatches: z.boolean().default(false),
    })
    .default({}),

  state: z
    .object({
      filePath: z.string().default('./data/sync-state.json'),
      backupOnWrite: z.boolean().default(true),
    })
    .default({}),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  dryRun: z.boolean().default(false),
});

export type ValidatedConfig = z.infer<typeof configSchema>;

/**
 * Normalise the vmware config to always be an array.
 * Supports both single-host (backward compat) and multi-host configs.
 */
export function getVmwareHosts(config: ValidatedConfig): VmwareHostConfig[] {
  const vmware = config.vmware;
  const hosts = Array.isArray(vmware) ? vmware : [vmware];
  // Default label to host if not provided
  return hosts.map((h) => ({ ...h, label: h.label ?? h.host }));
}
