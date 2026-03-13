/**
 * Application entry point.
 *
 * Supports two modes:
 *  --once    Run a single sync cycle and exit (exit code 1 on errors)
 *  (default) Run continuously on a schedule
 */

import { bootstrap } from './app';

const { scheduler, orchestrator, logger } = bootstrap();

const args = process.argv.slice(2);

if (args.includes('--once')) {
  // Single sync run, then exit
  orchestrator
    .execute()
    .then((result) => {
      logger.info('Single sync complete', {
        matched: result.matchedCount,
        tagsApplied: result.tagsApplied,
        errors: result.errors.length,
        durationMs: result.durationMs,
      });
      process.exit(result.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      logger.error(
        'Single sync failed',
        err instanceof Error ? err : new Error(String(err))
      );
      process.exit(1);
    });
} else {
  // Continuous mode with periodic scheduling
  scheduler.start();
}
