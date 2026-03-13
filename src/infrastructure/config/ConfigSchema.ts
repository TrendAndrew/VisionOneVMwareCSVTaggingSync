/**
 * Configuration schema and validation using Zod.
 *
 * Defines the shape of the application configuration with
 * sensible defaults and strict validation rules.
 */

import { z } from 'zod';

export const configSchema = z.object({
  vmware: z.object({
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
  }),

  visionone: z.object({
    apiToken: z.string().min(1, 'Vision One API token is required'),
    region: z.enum(['us', 'eu', 'jp', 'sg', 'au', 'in', 'mea'], {
      errorMap: () => ({
        message:
          'Vision One region must be one of: us, eu, jp, sg, au, in, mea',
      }),
    }),
    endpointPageSize: z.number().positive().default(200),
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
