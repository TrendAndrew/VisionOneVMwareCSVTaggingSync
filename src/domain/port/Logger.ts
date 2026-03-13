/**
 * Logger port.
 *
 * Provides a structured logging interface so the domain
 * layer does not depend on any concrete logging library.
 */

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}
