/**
 * The session flight recorder (production-harness catalog #5): a persisted,
 * per-task NDJSON ledger of every PreToolUse gate evaluation, plus session
 * start/end markers. The Rust core computes the path
 * (`<projectRoot>/.nightcore/ledger/<taskId>.ndjson`) and carries it on
 * `start-session`; [`SessionRunner`] owns one writer per session and feeds it
 * from the {@link HookBus} `onToolDecision` seam — the single point every
 * gate evaluation passes through, so one writer sees allow AND deny.
 *
 * Posture (a recorder must never become a gate):
 *   - **FAIL-OPEN**: any filesystem error warns ONCE and disables the writer —
 *     a ledger problem never blocks a tool call or fails a session;
 *   - **append-only**: sessions of the same task (build, reviewer, fix) share
 *     the file, separated by their start/end markers;
 *   - **synchronous appends**: each record is one small `appendFileSync` so a
 *     crash keeps every record up to the crash (the point of a flight
 *     recorder) and line order matches evaluation order;
 *   - **bounded**: at ~5 MB the writer emits one final `truncated` marker and
 *     stops — a pathological session can't fill the disk;
 *   - **digest, not payload**: only the first {@link DIGEST_MAX_CHARS} chars of
 *     the most relevant input field are recorded (the Bash command line or the
 *     target path — what the Rust detectors need), never full tool inputs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '@nightcore/shared';

/** The ledger size cap. Crossing it writes one final `truncated` marker line
 *  and disables the writer (see the module header). */
export const LEDGER_MAX_BYTES = 5 * 1024 * 1024;

/** Digest budget per record: enough of a Bash command line for the Rust-side
 *  detectors (`--no-verify` history) and any path, small enough that the file
 *  stays scannable. */
export const DIGEST_MAX_CHARS = 200;

/** The most-relevant input field per tool shape, in priority order: the Bash
 *  command line first, then the mutation/read target paths, then the common
 *  descriptive fields. First present non-empty string wins. */
const DIGEST_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'url',
  'pattern',
  'query',
  'prompt',
] as const;

/** One tool-evaluation record on the wire (marker lines carry `event`/
 *  `sessionId` instead of `tool`/`decision`). Exported for the writer tests;
 *  the Rust reader (`store/ledger.rs`) mirrors this shape leniently. */
export interface LedgerToolRecord {
  ts: string;
  tool: string;
  inputDigest: string;
  decision: 'allow' | 'deny';
  ruleId?: string;
}

/**
 * Reduce a tool input to its single most relevant field, truncated to
 * {@link DIGEST_MAX_CHARS}. Non-object inputs stringify; an object with none of
 * the known keys falls back to its (truncated) JSON — the detectors only need
 * Bash commands and paths, the fallback just keeps the record non-empty.
 */
export function digestToolInput(input: unknown): string {
  if (typeof input === 'string') return truncateDigest(input);
  if (input === null || typeof input !== 'object') {
    return truncateDigest(String(input ?? ''));
  }
  const record = input as Record<string, unknown>;
  for (const key of DIGEST_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return truncateDigest(value);
    }
  }
  try {
    return truncateDigest(JSON.stringify(input));
  } catch {
    // Circular / non-serializable input: an empty digest is still a record.
    return '';
  }
}

function truncateDigest(value: string): string {
  return value.length > DIGEST_MAX_CHARS ? value.slice(0, DIGEST_MAX_CHARS) : value;
}

/** The append-only NDJSON writer. Construct with the wire `ledgerPath`; every
 *  record method is safe to call unconditionally (fail-open, see the module
 *  header). `maxBytes` is injectable for the cap tests only. */
export class SessionLedger {
  /** Bytes already in the file, counted lazily on first append so a prior
   *  session's records (same task) count toward the shared cap. */
  private bytes?: number;
  /** Set on the first filesystem error (fail-open) or once the cap is hit. */
  private disabled = false;
  private warned = false;

  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
    private readonly maxBytes: number = LEDGER_MAX_BYTES,
  ) {}

  /** Record one PreToolUse gate evaluation. Bound (arrow) so it can be handed
   *  to the {@link HookBus} `onToolDecision` opt directly. */
  recordToolDecision = (
    tool: string,
    input: unknown,
    decision: 'allow' | 'deny',
    ruleId?: string,
  ): void => {
    this.append({
      tool,
      inputDigest: digestToolInput(input),
      decision,
      ...(ruleId !== undefined ? { ruleId } : {}),
    });
  };

  /** Marker line: a session began appending to this ledger. */
  recordSessionStart(sessionId: number): void {
    this.append({ event: 'session-start', sessionId });
  }

  /** Marker line: the session reached its terminal state. */
  recordSessionEnd(sessionId: number): void {
    this.append({ event: 'session-end', sessionId });
  }

  private append(fields: Record<string, unknown>): void {
    if (this.disabled) return;
    try {
      if (this.bytes === undefined) {
        // Lazy open: create parent dirs and count what a prior session of this
        // task already wrote (the cap is per FILE, not per writer).
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.bytes = fs.existsSync(this.filePath)
          ? fs.statSync(this.filePath).size
          : 0;
        if (this.bytes >= this.maxBytes) {
          // A prior writer crossed the cap (and wrote the marker); stay silent.
          this.disabled = true;
          return;
        }
      }
      const line = `${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (this.bytes + lineBytes > this.maxBytes) {
        // Crossing the cap: ONE final marker, then the recorder is off.
        const marker = `${JSON.stringify({ ts: new Date().toISOString(), event: 'truncated' })}\n`;
        fs.appendFileSync(this.filePath, marker);
        this.disabled = true;
        this.logger?.warn('session ledger reached its size cap; recording stopped', {
          maxBytes: this.maxBytes,
        });
        return;
      }
      fs.appendFileSync(this.filePath, line);
      this.bytes += lineBytes;
    } catch (error) {
      // FAIL-OPEN: a recorder error must never block a tool call. Warn once
      // (path only — never tool input), then drop records silently.
      this.disabled = true;
      if (!this.warned) {
        this.warned = true;
        this.logger?.warn('session ledger write failed; recording disabled', error);
      }
    }
  }
}
