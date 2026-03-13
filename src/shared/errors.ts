/**
 * Custom error hierarchy for the sync pipeline.
 *
 * All domain-specific errors extend SyncError so callers can catch
 * the base class when they need a generic handler.
 */

export class SyncError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'SyncError';
    if (cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class VmwareConnectionError extends SyncError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'VmwareConnectionError';
  }
}

export class VisionOneApiError extends SyncError {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number, cause?: Error) {
    super(message, cause);
    this.name = 'VisionOneApiError';
    this.statusCode = statusCode;
  }
}

export class MatchingError extends SyncError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'MatchingError';
  }
}

export class ConfigValidationError extends SyncError {
  public readonly field?: string;

  constructor(message: string, field?: string, cause?: Error) {
    super(message, cause);
    this.name = 'ConfigValidationError';
    this.field = field;
  }
}

export class SyncStateError extends SyncError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'SyncStateError';
  }
}
