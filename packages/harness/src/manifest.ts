/**
 * Parsing + planning of `.nightcore/harness.json` — a faithful Node port of the
 * in-process Rust loader (`workflow/gauntlet_project/config.rs`). Reads the
 * manifest, gates its `schemaVersion`, and turns the `checks[]` array into
 * spawnable {@link PlannedCheck}s. Every "skip" path (absent file, unreadable
 * file, malformed JSON, missing `checks` array, a disabled / command-less /
 * `shell` entry) yields nothing to run, so the gate trivially passes
 * (opt-in-by-presence) — byte-parity with `load_checks` returning an empty vec.
 *
 * Pure over an injected {@link FileReader} so it is unit-testable without a
 * filesystem.
 */
import path from 'node:path';

/** Repo-relative location of the manifest the runner reads. */
export const MANIFEST_RELATIVE_PATH = path.join('.nightcore', 'harness.json');

/**
 * The default per-check wall-clock timeout (ms) when a check declares no
 * `timeoutMs` (or a zero/garbage one). Mirrors the Rust `DEFAULT_CHECK_TIMEOUT`
 * (300s): generous for a whole-repo lint/coverage run, but bounded so a hung
 * check can never pin CI forever.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000;

/**
 * The highest manifest MAJOR schema version this runner can safely interpret.
 * A bundle stamped higher was authored by a newer Nightcore and must red the
 * build rather than silently pass (the fail-safe direction).
 */
export const SUPPORTED_SCHEMA_MAJOR = 1;

/** A check resolved into the program + args to spawn. */
export interface PlannedCheck {
  name: string;
  /** The manifest `kind` wire string, carried through verbatim to the result. */
  kind: string;
  /** The exact command line, retained for the result + fix instruction. */
  command: string;
  program: string;
  args: string[];
  /** The resolved per-check wall-clock timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * The result of loading a manifest. `no-config` (exit 0, opt-in-by-presence),
 * `schema-too-new` (exit non-zero, upgrade the runner), or `ready` with the
 * planned checks (possibly empty ⇒ trivially passing).
 */
export type ManifestOutcome =
  | { kind: 'no-config' }
  | { kind: 'schema-too-new'; found: number }
  | { kind: 'ready'; checks: PlannedCheck[] };

/** Reads an absolute path, returning its contents or `null` if unreadable. */
export type FileReader = (absolutePath: string) => string | null;

/** The absolute manifest path for a target directory. */
export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_RELATIVE_PATH);
}

/**
 * Resolve the runner's understanding of the root `schemaVersion`. Absent ⇒
 * treated as `1` (a manifest armed before the stamp is a valid v1 bundle). A
 * finite value is floored to its MAJOR; anything unparseable is treated as
 * "too new" (fail-safe).
 */
function resolveSchema(raw: unknown): { tooNew: boolean; found: number } {
  if (raw === undefined || raw === null) return { tooNew: false, found: SUPPORTED_SCHEMA_MAJOR };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { tooNew: true, found: Number.NaN };
  const major = Math.floor(n);
  return { tooNew: major > SUPPORTED_SCHEMA_MAJOR, found: major };
}

/**
 * Resolve one raw manifest entry into a spawnable plan, or `null` when it is not
 * runnable (mirrors `load_checks` + `plan_check`):
 *  - not an object, or a missing/blank/non-string `name` ⇒ skip (malformed).
 *  - `enabled === false` ⇒ skip (explicitly disabled).
 *  - `kind === "shell"` ⇒ skip (the shell drift substrate's execution is a
 *    deliberate fast-follow — a ripgrep `--count` exit code is not a gate verdict).
 *  - absent / blank `command` ⇒ skip (nothing deterministic to run).
 *
 * Any other `kind` (including an unknown/future one) that has a command runs:
 * the runner treats everything except `schemaVersion` as data, so a
 * version-pinned CI stays forward-compatible.
 */
export function planCheck(entry: unknown): PlannedCheck | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const cfg = entry as Record<string, unknown>;

  if (typeof cfg.name !== 'string' || cfg.name.trim() === '') return null;
  if (cfg.enabled === false) return null;

  const kind = typeof cfg.kind === 'string' ? cfg.kind : '';
  if (kind === 'shell') return null;

  const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  if (command === '') return null;

  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  const program = tokens[0];
  if (program === undefined) return null;
  const args = tokens.slice(1);

  const declared = cfg.timeoutMs;
  const timeoutMs =
    typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? Math.floor(declared)
      : DEFAULT_CHECK_TIMEOUT_MS;

  return { name: cfg.name, kind, command, program, args, timeoutMs };
}

/**
 * Load + plan the enabled checks from `.nightcore/harness.json` in `dir`,
 * reading through the injected {@link FileReader}. See {@link ManifestOutcome}
 * for the non-`ready` paths.
 */
export function loadChecks(dir: string, read: FileReader): ManifestOutcome {
  const raw = read(manifestPath(dir));
  // ABSENT / unreadable ⇒ opt out of the whole project (byte-parity with the
  // Rust loader's read-error arm).
  if (raw === null) return { kind: 'no-config' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Malformed JSON ⇒ warn-and-skip everything (exit 0), never a hard failure.
    return { kind: 'no-config' };
  }
  if (typeof value !== 'object' || value === null) return { kind: 'no-config' };
  const root = value as Record<string, unknown>;

  // The schemaVersion gate is evaluated BEFORE the checks array: a bundle the
  // runner can't safely interpret must red the build even if its checks are
  // absent.
  const schema = resolveSchema(root.schemaVersion);
  if (schema.tooNew) return { kind: 'schema-too-new', found: schema.found };

  const entries = root.checks;
  if (!Array.isArray(entries)) return { kind: 'no-config' };

  const checks: PlannedCheck[] = [];
  for (const entry of entries) {
    const planned = planCheck(entry);
    if (planned !== null) checks.push(planned);
  }
  return { kind: 'ready', checks };
}
