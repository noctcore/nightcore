/** A tiny structured console logger for the web tier (#245).
 *
 * Emits structured records — `level`, `scope`, `message`, and optional `fields` —
 * instead of bare `console.*` calls, so UI diagnostics are greppable and there is a
 * single seam future telemetry can hook. This is deliberately thin: a wrapper over
 * `console` with level methods, NOT a telemetry pipeline. Forwarding these records
 * into the Rust `tracing` trail (a remote sink / forward-to-Rust bridge) is a possible
 * follow-up, explicitly out of scope here. */

/** Console severity levels the logger routes to. Distinct from the Rust-core
 *  `logLevel` setting vocabulary (which adds `trace`) — these are browser console
 *  methods, not `tracing` levels. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Extra structured context attached to a record. Logged as-is, so callers must not
 *  pass secrets or large payloads (the same discipline the Rust `#[instrument]` spans
 *  follow). */
export type LogFields = Record<string, unknown>;

/** The structured record every log method emits — also the shape a future remote sink
 *  would serialize. */
export interface LogRecord {
  level: LogLevel;
  /** A short dotted area tag (e.g. `ui.error-boundary`) for grep + future routing. */
  scope: string;
  message: string;
  fields?: LogFields;
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  const record: LogRecord = { level, scope, message };
  if (fields && Object.keys(fields).length > 0) record.fields = fields;
  // The single console seam. A human-readable prefix keeps the console legible; the
  // structured record rides alongside for greppable, machine-readable context.
  console[level](`[${scope}] ${message}`, record);
}

/** The structured web logger. Call `logger.error(scope, message, fields?)`. */
export const logger = {
  error: (scope: string, message: string, fields?: LogFields): void =>
    emit('error', scope, message, fields),
  warn: (scope: string, message: string, fields?: LogFields): void =>
    emit('warn', scope, message, fields),
  info: (scope: string, message: string, fields?: LogFields): void =>
    emit('info', scope, message, fields),
  debug: (scope: string, message: string, fields?: LogFields): void =>
    emit('debug', scope, message, fields),
};
