/**
 * Periodic sync scheduler with signal handling.
 *
 * Runs the SyncOrchestrator on a configurable interval.
 * Supports:
 *  - SIGHUP: reload configuration and mapping overrides without restart
 *  - SIGTERM/SIGINT: graceful shutdown
 *  - Guard against overlapping sync cycles
 */

import { SyncOrchestrator } from './SyncOrchestrator';
import { Logger } from '../domain/port/Logger';
import { MappingOverrideProvider } from '../domain/port/MappingOverrideProvider';
import { EnvConfigProvider } from '../infrastructure/config/EnvConfigProvider';

export class SyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private shuttingDown = false;

  constructor(
    private readonly orchestrator: SyncOrchestrator,
    private readonly intervalMinutes: number,
    private readonly logger: Logger,
    private readonly configProvider: EnvConfigProvider,
    private readonly mappingOverrides: MappingOverrideProvider
  ) {}

  /**
   * Start the scheduler.
   *
   * Registers signal handlers, runs an immediate sync cycle,
   * then schedules subsequent cycles at the configured interval.
   */
  start(): void {
    this.logger.info('Sync scheduler starting', {
      intervalMinutes: this.intervalMinutes,
    });

    this.registerSignalHandlers();

    // Run immediately, then on interval
    this.runCycle();
    this.timer = setInterval(
      () => this.runCycle(),
      this.intervalMinutes * 60 * 1000
    );
  }

  /**
   * Run a single sync cycle (for --once mode).
   */
  async runOnce(): Promise<void> {
    await this.orchestrator.execute();
  }

  /**
   * Stop the scheduler and exit the process.
   */
  stop(): void {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    this.logger.info('Sync scheduler stopping');

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    process.exit(0);
  }

  /**
   * Register OS signal handlers for config reload and graceful shutdown.
   */
  private registerSignalHandlers(): void {
    // SIGHUP: reload config and mapping overrides without restart
    process.on('SIGHUP', () => {
      this.handleSighup();
    });

    // SIGTERM/SIGINT: graceful shutdown
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Handle SIGHUP by reloading configuration and mapping overrides.
   */
  private async handleSighup(): Promise<void> {
    this.logger.info(
      'SIGHUP received -- reloading configuration and mapping overrides'
    );

    try {
      this.configProvider.load();
      this.logger.info('Configuration reloaded successfully');
    } catch (err) {
      this.logger.error(
        'Failed to reload configuration on SIGHUP',
        err instanceof Error ? err : new Error(String(err))
      );
    }

    try {
      const overrides = await this.mappingOverrides.reload();
      this.logger.info('Mapping overrides reloaded successfully', {
        overrideCount: overrides.length,
      });
    } catch (err) {
      this.logger.error(
        'Failed to reload mapping overrides on SIGHUP',
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  /**
   * Execute a sync cycle with overlap guard.
   *
   * If a previous cycle is still running, the new cycle is skipped
   * to prevent concurrent API calls and state corruption.
   */
  private async runCycle(): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous sync cycle still running, skipping');
      return;
    }

    this.running = true;
    try {
      await this.orchestrator.execute();
    } catch (err) {
      this.logger.error(
        'Sync cycle error',
        err instanceof Error ? err : new Error(String(err))
      );
    } finally {
      this.running = false;
    }
  }
}
