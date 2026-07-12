/**
 * Public type surface of `@nightcore/harness`. Today this exposes the
 * `.nightcore/harness.json` manifest shape plus the `StructureLockResult`-shaped
 * verdict the runner emits (camelCase, wire-compatible with the Rust
 * `StructureLockResult` / `StructureLockCheck`). PR 2 adds the portable lint-meta
 * contract (`IMetaRule` / `IMetaCtx` / `IViolation`) here.
 *
 * This barrel exists so generated artifacts and downstream tooling can
 * `import type` from the published package.
 */
export type { ManifestOutcome, PlannedCheck } from './manifest.js';
export type {
  CheckStatus,
  StructureLockCheck,
  StructureLockResult,
} from './run.js';

/** One check as declared in `.nightcore/harness.json`. */
export interface HarnessManifestCheck {
  /** The logical check name (e.g. `folder-per-component`). */
  name: string;
  /** The harness kind (e.g. `lint-plugin`, `ast-grep`). Free-form on the wire. */
  kind: string;
  /** The exact command line to run (e.g. `npx eslint .`). */
  command?: string;
  /** Optional config path for the underlying tool (informational). */
  configPath?: string;
  /** Per-check wall-clock timeout in milliseconds (`> 0`, else the default). */
  timeoutMs?: number;
  /** Whether the check participates in the gate. Defaults to `true`. */
  enabled?: boolean;
}

/** The `.nightcore/harness.json` manifest the runner reads. */
export interface HarnessManifest {
  /**
   * The manifest MAJOR schema version. Absent ⇒ treated as `1`. A higher MAJOR
   * than the runner supports reds the build (upgrade the runner).
   */
  schemaVersion?: number;
  /** The checks the runner enforces. Absent/empty ⇒ nothing to enforce. */
  checks?: HarnessManifestCheck[];
  /**
   * The Nightcore agent-runtime policy block. Carried for Nightcore-driven
   * consumers; the CI runner does not interpret it.
   */
  policy?: Record<string, unknown>;
}
