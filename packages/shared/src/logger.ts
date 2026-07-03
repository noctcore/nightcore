/**
 * Tiny structured logger. No runtime dependencies — writes leveled lines to
 * stderr so stdout stays clean for the CLI's machine-readable / streamed output.
 */

// `LogLevel` is owned by @nightcore/contracts (the base contract layer, rank 1)
// as the `LogLevelSchema` zod enum; shared (rank 2) may depend on it. This is a
// TYPE-ONLY import (erased at runtime, so the logger keeps zero runtime deps) and
// the single source of truth — the `Record<LogLevel, …>` tables below now fail to
// compile if contracts adds or renames a level, killing the old silent-drift risk.
import type { LogLevel } from '@nightcore/contracts';

// Re-export so `@nightcore/shared` consumers keep importing `LogLevel` from here.
export type { LogLevel };

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
  if (meta instanceof Error) return formatError(meta);
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

/**
 * Render an Error with its stack and `.cause` chain — a bare `name: message`
 * discards the trace a real crash needs. Kept to a SINGLE line: `format()`'s
 * wire contract requires the LEVEL token at field 0 of every captured line, so
 * a multi-line stack would collapse its follow-on lines to `Info` on the Rust
 * side. Newlines are folded to ` ⏎ `; the cause chain is bounded to avoid cycles.
 */
function formatError(err: Error): string {
  const flatten = (e: Error): string =>
    (e.stack ?? `${e.name}: ${e.message}`).replace(/\s*\n\s*/g, ' ⏎ ');
  const parts = [flatten(err)];
  let cause: unknown = (err as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && depth < 5; depth++) {
    if (cause instanceof Error) {
      parts.push(`caused by: ${flatten(cause)}`);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(`caused by: ${String(cause)}`);
      break;
    }
  }
  return parts.join(' | ');
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
