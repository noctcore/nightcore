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
 * Whether stderr is an interactive TTY. Gates BOTH the LEVEL colorization and the
 * full pretty self-format (the leading ISO timestamp): on a TTY a human running the
 * CLI directly gets `<ISO> <LEVEL> [scope] <msg> <json>`. When piped/captured — the
 * Rust core draining our stderr, or a redirect to a file — output drops the self
 * timestamp so the Rust `tracing` sink can own the single timestamp + level without
 * double-stamping every line.
 */
function useColor(): boolean {
  return process.stderr.isTTY === true;
}

/**
 * Format one log line in one of two shapes, gated on {@link useColor} (TTY):
 *
 * - Interactive TTY: the full pretty self-format `<ISO> <LEVEL> [scope] <msg> <json>`,
 *   LEVEL colorized.
 * - Piped/captured (non-TTY, e.g. the Rust core draining our stderr): drop our own ISO
 *   timestamp and emit `<LEVEL> [scope] <msg> <json>`. Rust's tracing sink stamps the
 *   single timestamp + level; a self-timestamp here would double-stamp every line. The
 *   `[scope]` is kept because Rust's flat `target: "sidecar"` does not preserve the
 *   child scope (`sidecar:harness` vs `sidecar:insight`).
 *
 * WIRE CONTRACT — keep in lockstep with the Rust parser (`sidecar_level` /
 * `strip_level_token` in apps/desktop/src-tauri/src/sidecar/mod.rs): in piped mode the
 * uppercase LEVEL token MUST be field 0 (first whitespace-delimited field) and plain
 * (no ANSI), so Rust can recover the tracing level from field 0 and strip it. Moving
 * the LEVEL token here without moving that parser silently collapses every captured
 * line to `Info`.
 */
function format(scope: string, level: LogLevel, msg: string, meta?: unknown): string {
  const tail = meta === undefined ? '' : ` ${safeStringify(meta)}`;
  const levelToken = level.toUpperCase();
  if (!useColor()) {
    // Captured by Rust (or a file): LEVEL stays first so the Rust side parses + strips
    // it; the self-timestamp is omitted (Rust stamps the only one), [scope] preserved.
    return `${levelToken} [${scope}] ${msg}${tail}`;
  }
  const ts = new Date().toISOString();
  const level_ =
    level === 'silent' ? levelToken : `${LEVEL_COLOR[level]}${levelToken}${RESET}`;
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
