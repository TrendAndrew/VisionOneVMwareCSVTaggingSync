/**
 * Application bootstrap.
 *
 * Wires all dependencies together following the Ports & Adapters
 * (hexagonal) architecture. Infrastructure adapters are instantiated
 * and injected into domain services and the application orchestrator.
 */

import fs from 'fs';
import path from 'path';
import { EnvConfigProvider } from './infrastructure/config/EnvConfigProvider';
import { getVmwareHosts } from './infrastructure/config/ConfigSchema';
import { WinstonLogger } from './infrastructure/logging/WinstonLogger';
import { MultiVmwareGateway } from './infrastructure/vmware/MultiVmwareGateway';
import { VisionOneGatewayImpl } from './infrastructure/visionone/VisionOneGatewayImpl';
import { FileSyncStateRepo } from './infrastructure/state/FileSyncStateRepo';
import { MappingOverrideFile } from './infrastructure/config/MappingOverrideFile';
import { UnmatchedReporter } from './infrastructure/logging/UnmatchedReporter';
import { MatchingService } from './domain/service/MatchingService';
import { DiffService } from './domain/service/DiffService';
import { TagNamingService } from './domain/service/TagNamingService';
import { SyncOrchestrator } from './application/SyncOrchestrator';
import { SyncScheduler } from './application/SyncScheduler';
import { DryRunDecorator } from './application/DryRunDecorator';
import { VisionOneGateway } from './domain/port/VisionOneGateway';

export interface AppContext {
  scheduler: SyncScheduler;
  orchestrator: SyncOrchestrator;
  config: ReturnType<EnvConfigProvider['load']>;
  logger: WinstonLogger;
}

export function bootstrap(): AppContext {
  // Load and validate configuration
  const configProvider = new EnvConfigProvider();
  const config = configProvider.load();
  const logger = new WinstonLogger(config.logLevel);

  // Normalise VMware config to array (supports single or multi-host)
  const vmwareHosts = getVmwareHosts(config);

  logger.info('VMwareTagging starting', {
    dryRun: config.dryRun,
    region: config.visionone.region,
    syncInterval: config.sync.intervalMinutes,
    matchStrategy: config.matching.strategy,
    vCenterHosts: vmwareHosts.map((h) => h.label),
  });

  // VMware gateway -- aggregates VMs from all configured vCenters
  const vmwareGateway = new MultiVmwareGateway(vmwareHosts, logger);

  // Vision One gateway -- constructor creates its own rest client and paginator
  const v1Gateway = new VisionOneGatewayImpl(
    config.visionone.apiToken,
    config.visionone.region,
    config.visionone.endpointPageSize,
    config.visionone.requestTimeoutMs,
    config.visionone.rateLimitDelayMs
  );

  // Wrap with DryRunDecorator if configured
  const visionOneGateway: VisionOneGateway = config.dryRun
    ? new DryRunDecorator(v1Gateway, logger)
    : v1Gateway;

  // Sync state persistence
  const syncStateRepo = new FileSyncStateRepo(
    config.state.filePath,
    config.state.backupOnWrite
  );

  // Mapping overrides (admin-managed file)
  const mappingOverrides = new MappingOverrideFile(
    './config/mapping-overrides.json'
  );

  // Domain services
  const matchingService = new MatchingService({
    strategy: config.matching.strategy,
    hostnameNormalization: config.matching.hostnameNormalization,
    ipMatchMode: config.matching.ipMatchMode,
    allowMultipleMatches: config.matching.allowMultipleMatches,
  });

  // Load orphan removal allowlist if configured
  let orphanRemovalAllowlist: Set<string> | undefined;
  if (config.sync.orphanRemovalAllowlistFile) {
    const allowlistPath = path.resolve(config.sync.orphanRemovalAllowlistFile);
    try {
      const raw = fs.readFileSync(allowlistPath, 'utf-8');
      const parsed = JSON.parse(raw) as string[];
      orphanRemovalAllowlist = new Set(parsed);
      logger.info('Orphan removal allowlist loaded', {
        file: allowlistPath,
        tagCount: orphanRemovalAllowlist.size,
      });
    } catch (err) {
      logger.error(
        `Failed to load orphan removal allowlist from ${allowlistPath}`,
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  const diffService = new DiffService({
    removeOrphanedTags: config.sync.removeOrphanedTags,
    orphanRemovalPrefix: config.sync.tagPrefix,
    orphanRemovalAllowlist,
  });

  const tagNamingService = new TagNamingService({
    tagPrefix: config.sync.tagPrefix,
    categorySeparator: config.sync.categorySeparator,
    maxTagNameLength: config.sync.maxTagNameLength,
  });

  // Unmatched report writer
  const unmatchedReporter = new UnmatchedReporter(
    './data/unmatched-report.json'
  );

  // Sync orchestrator -- the heart of the system
  const orchestrator = new SyncOrchestrator(
    vmwareGateway,
    visionOneGateway,
    syncStateRepo,
    matchingService,
    diffService,
    tagNamingService,
    mappingOverrides,
    unmatchedReporter,
    logger
  );

  // Scheduler with signal handling
  const scheduler = new SyncScheduler(
    orchestrator,
    config.sync.intervalMinutes,
    logger,
    configProvider,
    mappingOverrides
  );

  return { scheduler, orchestrator, config, logger };
}
