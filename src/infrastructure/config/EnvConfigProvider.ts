/**
 * Configuration provider that merges environment variables
 * with an optional JSON config file and validates the result
 * using the Zod config schema.
 *
 * Env vars take precedence over file-based config, allowing
 * deployment-specific overrides without touching config files.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { configSchema, ValidatedConfig } from './ConfigSchema';
import { ConfigValidationError } from '../../shared/errors';

export class EnvConfigProvider {
  private config: ValidatedConfig | null = null;

  /**
   * Load, merge, and validate configuration.
   *
   * Reads .env file first (if present), then an optional JSON
   * config file, then overlays env vars on top. The merged
   * result is validated against the Zod schema.
   *
   * @throws ConfigValidationError when validation fails.
   */
  load(): ValidatedConfig {
    dotenv.config();

    const fileConfig = this.loadFileConfig();
    const merged = this.mergeWithEnv(fileConfig);

    try {
      this.config = configSchema.parse(merged);
      return this.config;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      throw new ConfigValidationError(
        `Configuration validation failed: ${message}`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Return the cached config, loading on first access.
   */
  get(): ValidatedConfig {
    if (!this.config) {
      return this.load();
    }
    return this.config;
  }

  /**
   * Read the JSON config file if it exists.
   */
  private loadFileConfig(): Record<string, unknown> {
    const configPath = process.env.CONFIG_PATH || './config/default.json';
    const resolvedPath = path.resolve(configPath);

    if (!fs.existsSync(resolvedPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigValidationError(
        `Failed to read config file at ${resolvedPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'CONFIG_PATH',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Merge file-based config with environment variables.
   * Env vars win over file values when both are present.
   */
  private mergeWithEnv(
    fileConfig: Record<string, unknown>
  ): Record<string, unknown> {
    const fileVisionone = (fileConfig.visionone ?? {}) as Record<
      string,
      unknown
    >;

    return {
      ...fileConfig,
      vmware: this.mergeVmwareConfig(fileConfig.vmware),
      visionone: {
        ...fileVisionone,
        ...this.envOverride(
          'VISIONONE_API_TOKEN',
          fileVisionone.apiToken,
          'apiToken'
        ),
        ...this.envOverride(
          'VISIONONE_REGION',
          fileVisionone.region,
          'region'
        ),
        ...this.envNumberOverride(
          'VISIONONE_DEVICE_PAGE_SIZE',
          fileVisionone.devicePageSize,
          'devicePageSize'
        ),
        ...this.envNumberOverride(
          'VISIONONE_REQUEST_TIMEOUT_MS',
          fileVisionone.requestTimeoutMs,
          'requestTimeoutMs'
        ),
        ...this.envNumberOverride(
          'VISIONONE_RATE_LIMIT_DELAY_MS',
          fileVisionone.rateLimitDelayMs,
          'rateLimitDelayMs'
        ),
      },
      ...this.envOverride('LOG_LEVEL', fileConfig.logLevel, 'logLevel'),
      ...this.envBoolOverride('DRY_RUN', fileConfig.dryRun, 'dryRun'),
    };
  }

  /**
   * Return a partial object with the given key set to the env value
   * if the env var exists, otherwise set to the fallback.
   */
  private envOverride(
    envKey: string,
    fallback: unknown,
    configKey: string
  ): Record<string, unknown> {
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      return { [configKey]: envValue };
    }
    if (fallback !== undefined) {
      return { [configKey]: fallback };
    }
    return {};
  }

  private envBoolOverride(
    envKey: string,
    fallback: unknown,
    configKey: string
  ): Record<string, unknown> {
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      return { [configKey]: envValue === 'true' };
    }
    if (fallback !== undefined) {
      return { [configKey]: fallback };
    }
    return {};
  }

  private envNumberOverride(
    envKey: string,
    fallback: unknown,
    configKey: string
  ): Record<string, unknown> {
    const envValue = process.env[envKey];
    if (envValue !== undefined) {
      const num = Number(envValue);
      if (Number.isFinite(num)) {
        return { [configKey]: num };
      }
    }
    if (fallback !== undefined) {
      return { [configKey]: fallback };
    }
    return {};
  }

  /**
   * Merge VMware configuration.
   *
   * Supports three scenarios:
   * 1. Multi-host array in JSON config → use as-is (env vars ignored for multi-host)
   * 2. Single host in JSON config → overlay env vars on top
   * 3. No JSON config → build single host from env vars only
   *
   * For multi-host, credentials should be in the JSON config file
   * (not in env vars, since env vars can only represent one host).
   */
  private mergeVmwareConfig(
    fileVmware: unknown
  ): unknown {
    // Multi-host array: use as-is from JSON config
    if (Array.isArray(fileVmware)) {
      return fileVmware;
    }

    // Single host: overlay env vars
    const single = (fileVmware ?? {}) as Record<string, unknown>;
    return {
      ...single,
      ...this.envOverride('VMWARE_HOST', single.host, 'host'),
      ...this.envOverride('VMWARE_USERNAME', single.username, 'username'),
      ...this.envOverride('VMWARE_PASSWORD', single.password, 'password'),
      ...this.envBoolOverride('VMWARE_VERIFY_SSL', single.verifySsl, 'verifySsl'),
      ...this.envNumberOverride('VMWARE_REQUEST_TIMEOUT_MS', single.requestTimeoutMs, 'requestTimeoutMs'),
    };
  }
}
