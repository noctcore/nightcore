/**
 * Tiny structured logger. No dependencies — writes leveled lines to stderr so
 * stdout stays clean for the CLI's machine-readable / streamed output.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

/** SGR color codes per level; applied only to the LEVEL token, only on a TTY. */
const LEVEL_COLOR: Record<Exclude<LogLevel, 'silent'>, string> = {
  error: '\x1b[31m', // red
  warn: '\x1b[33m', // yellow
  info: '\x1b[36m', // cyan
  debug: '\x1b[2m', // dim
};
const RESET = '\x1b[0m';

/**
 * Whether to colorize: only when stderr is an interactive TTY. When the Rust core
 * captures our stderr (piped, not a TTY) or it is redirected to a file, output
 * stays plain so the `<ISO> <LEVEL> [scope] <msg> <json>` shape is parseable.
 */
function useColor(): boolean {
  return process.stderr.isTTY === true;
}

function format(scope: string, level: LogLevel, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const tail = meta === undefined ? '' : ` ${safeStringify(meta)}`;
  const levelToken = level.toUpperCase();
  const level_ =
    useColor() && level !== 'silent'
      ? `${LEVEL_COLOR[level]}${levelToken}${RESET}`
      : levelToken;
  return `${ts} ${level_} [${scope}] ${msg}${tail}`;
}

function safeStringify(meta: unknown): string {
  if (meta instanceof Error) return `${meta.name}: ${meta.message}`;
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

export function createLogger(level: LogLevel = 'info', scope = 'nightcore'): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const emit = (lvl: LogLevel, msg: string, meta?: unknown): void => {
    if (LEVEL_WEIGHT[lvl] > threshold) return;
    process.stderr.write(`${format(scope, lvl, msg, meta)}\n`);
  };
  return {
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
    child: (childScope) => createLogger(level, `${scope}:${childScope}`),
  };
}

/** Default logger instance; reconfigure per-app with {@link createLogger}. */
export const logger = createLogger();
