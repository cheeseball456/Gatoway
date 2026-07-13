import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  /** Absolute path (including filename) of the active log file. */
  logFilePath: string;
  /** Rotation threshold, in bytes. */
  maxSizeBytes: number;
  /** Number of rotated files to retain in addition to the active file. */
  maxFiles: number;
  /** Minimum log level. Defaults to "info". */
  level?: string;
}

/**
 * Converts a byte threshold into a pino-roll `size` string. Uses kilobytes for
 * sub-megabyte thresholds so rotation can be forced at a small size in tests
 * (tasks.md 6.5), and megabytes otherwise (design.md D6's 10MB default).
 */
function sizeOption(bytes: number): string {
  const oneMegabyte = 1024 * 1024;
  if (bytes < oneMegabyte) {
    return `${Math.max(1, Math.ceil(bytes / 1024))}k`;
  }
  return `${Math.max(1, Math.ceil(bytes / oneMegabyte))}m`;
}

/**
 * Creates the structured logger used throughout Gatoway core.
 *
 * Writes newline-delimited JSON to a local, size-rotating log file (design.md D6):
 * short-term debugging retention, not long-term archival (REQUIREMENTS.md NFR 3.6).
 */
export function createLogger(options: LoggerOptions): Logger {
  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: options.logFilePath,
      size: sizeOption(options.maxSizeBytes),
      mkdir: true,
      limit: { count: options.maxFiles },
    },
  });

  return pino({ level: options.level ?? "info" }, transport);
}
