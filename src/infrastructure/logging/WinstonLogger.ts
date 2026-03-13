/**
 * Winston-based structured logger implementing the Logger port.
 *
 * Outputs JSON-structured logs with timestamps and error stacks
 * to the console. Colorized output for development; structured
 * JSON for production.
 */

import winston from 'winston';
import { Logger as ILogger } from '../../domain/port/Logger';

export class WinstonLogger implements ILogger {
  private logger: winston.Logger;

  constructor(level: string = 'info') {
    this.logger = winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level: lvl, message, ...meta }) => {
              const contextStr = Object.keys(meta).length > 0
                ? ` ${JSON.stringify(meta)}`
                : '';
              return `${timestamp} ${lvl}: ${message}${contextStr}`;
            })
          ),
        }),
      ],
    });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.logger.info(message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.logger.warn(message, context);
  }

  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    this.logger.error(message, {
      ...context,
      ...(error && {
        errorName: error.name,
        errorMessage: error.message,
        stack: error.stack,
      }),
    });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.logger.debug(message, context);
  }
}
