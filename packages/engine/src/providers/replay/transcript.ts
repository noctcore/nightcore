/**
 * Transcript loading for the replay provider — E2E ladder rings 2–3 (issue #406).
 *
 * A transcript is an NDJSON file: one serialized `NightcoreEvent` per line, in wire
 * order — the exact shape a real sidecar's stdout carries. The canonical set lives at
 * `apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures/` and is shared with ring
 * 1(c)'s Rust drivers; there is deliberately ONE copy (a second would drift silently).
 *
 * Everything here is pure-ish and fail-LOUD by design. A ring that replays an empty or
 * malformed transcript is exactly the vacuous CI job this ladder exists to avoid, so:
 *
 *  - a missing directory / missing file throws (the sidecar surfaces it as a terminal
 *    `session-failed`, never a silent no-op run),
 *  - every line is validated against `NightcoreEventSchema` — a fixture that drifts
 *    from the contract fails HERE rather than being dropped later by the sidecar's
 *    outbound validator (which would leave a run that emits nothing and "passes"),
 *  - a transcript with no terminal event throws: a replay that never settles would
 *    hang the ring instead of failing it.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  type NightcoreEvent,
  NightcoreEventSchema,
  type TaskKind,
} from '@nightcore/contracts';

/** Filename extension every transcript carries. */
const TRANSCRIPT_EXT = '.jsonl';

/**
 * A prompt whose FIRST line is `#replay <name>` selects that transcript by name. This
 * is the only channel a ring needs to drive several scenarios (success / failure /…)
 * through one live sidecar without adding a field to the `SurfaceCommand` contract for
 * a test-only provider. The directive is consumed by THIS provider alone — a real
 * provider never sees it, because a real provider is never registered when
 * `NIGHTCORE_E2E_REPLAY` is set.
 */
const DIRECTIVE = /^#replay[ \t]+([a-z0-9][a-z0-9-]*)[ \t]*$/;

/** Transcript chosen for a run that carries no `#replay` directive, keyed by task
 *  kind. Every kind maps to the build transcript today: the session seam only ever
 *  carries session-correlated runs, and the scan families (`analysis-*`,
 *  `pr-review-*`) ride their own managers, not `AgentProvider`. Kept as a map rather
 *  than a constant so a future kind-specific transcript is a one-line addition. */
const DEFAULT_BY_KIND: Partial<Record<TaskKind, string>> = {};
const DEFAULT_TRANSCRIPT = 'build';

/**
 * The transcript name a run resolves to: the `#replay <name>` directive when the
 * prompt opens with one, else the task kind's default, else `build`. Pure.
 */
export function transcriptNameFor(params: {
  prompt: string;
  kind?: TaskKind;
}): string {
  const firstLine = params.prompt.split('\n', 1)[0]?.trim() ?? '';
  const directive = DIRECTIVE.exec(firstLine);
  if (directive) return directive[1]!;
  return (params.kind && DEFAULT_BY_KIND[params.kind]) ?? DEFAULT_TRANSCRIPT;
}

/**
 * Parse one NDJSON transcript body into its ordered events, validating every line
 * against the wire contract. Blank lines are skipped (a fixture may group visually);
 * every other line MUST be a contract-valid `NightcoreEvent` or this throws naming the
 * offending line — a silently dropped line would let a broken fixture "pass" by
 * replaying less than it claims.
 *
 * The Rust sibling (`e2e::transcript_replay::replay::parse_transcript`) applies the
 * same rule to the same files; this one additionally type-checks against zod, because
 * the engine has the schema available and the Rust side does not.
 */
export function parseTranscript(name: string, raw: string): NightcoreEvent[] {
  const events: NightcoreEvent[] = [];
  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(
        `replay transcript '${name}' line ${index + 1} is not valid JSON: ${String(error)}`,
      );
    }
    const validated = NightcoreEventSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `replay transcript '${name}' line ${index + 1} is not a valid NightcoreEvent: ${validated.error.message}`,
      );
    }
    events.push(validated.data);
  }
  if (events.length === 0) {
    throw new Error(`replay transcript '${name}' is empty`);
  }
  const terminal = events.at(-1)!.type;
  if (terminal !== 'session-completed' && terminal !== 'session-failed') {
    throw new Error(
      `replay transcript '${name}' ends on '${terminal}'; a session transcript must ` +
        'end on session-completed or session-failed or the replay would never settle',
    );
  }
  return events;
}

/**
 * Read + parse the named transcript from `dir`. Throws (naming the resolved path) when
 * the file is absent, so a typo'd fixture name reds the ring instead of quietly
 * running nothing. The name is constrained to the directive's own character class, so
 * a caller can never escape `dir` with a traversal segment.
 */
export function loadTranscript(dir: string, name: string): NightcoreEvent[] {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `invalid replay transcript name '${name}': expected lowercase letters, digits and dashes`,
    );
  }
  const file = path.join(dir, `${name}${TRANSCRIPT_EXT}`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`replay transcript '${name}' not found at ${file}: ${String(error)}`);
  }
  return parseTranscript(name, raw);
}

/**
 * Re-stamp a recorded event onto the LIVE session id. The fixtures carry whatever id
 * the recorded run used; every consumer downstream (the Rust reader's FIFO
 * correlation, the web transcript view) keys off `sessionId`, so replaying the
 * recorded id verbatim would bind the run to a session that does not exist. Events
 * without a `sessionId` (none in the session family today) pass through untouched.
 */
export function restampSessionId(
  event: NightcoreEvent,
  sessionId: number,
): NightcoreEvent {
  if (!('sessionId' in event)) return event;
  return { ...event, sessionId };
}
