// @ts-check
/**
 * The lint-meta engine enforces what ESLint cannot reach: cross-file contracts,
 * non-JS files, and config parity across the monorepo. Rules are pure functions
 * of an `IMetaCtx` and return violations; the CLI exits non-zero when any
 * `ciCritical` rule reports a violation.
 */

export interface IMetaCtx {
  /** Absolute repo root. */
  readonly root: string;
  /** Read a repo-relative file, or null if it does not exist. */
  read(rel: string): string | null;
  /** Whether a repo-relative path exists. */
  exists(rel: string): boolean;
  /** Glob repo-relative paths (Bun glob, cwd = root). */
  glob(pattern: string): string[];
  /** Run a shell command at the repo root; never throws. */
  exec(cmd: string): { code: number; stdout: string; stderr: string };
}

export interface IViolation {
  file: string;
  rule: string;
  message: string;
  /**
   * 1-indexed source location, when the rule can pinpoint one. Optional and
   * additive: existing rules omit it and the text reporter ignores it; the
   * `--json` reporter surfaces `line`/`column` only when present (see
   * `json-reporter.ts`).
   */
  line?: number;
  column?: number;
}

export interface IMetaRule {
  id: string;
  category: 'config' | 'source-text' | 'supply-chain' | 'ci' | 'testing';
  description: string;
  /** When true, a violation fails CI (exit non-zero). */
  ciCritical?: boolean;
  run(ctx: IMetaCtx): IViolation[];
  /**
   * Ratcheting rules implement this to snapshot the CURRENT offenders as a frozen
   * baseline (a flat `metric-key → number` map). `cli.ts --update-baseline` writes
   * the return value to `baselines/<id>.json`; `run` then grandfathers any offender
   * still within its recorded value (see `baseline.ts`). Omit for strict rules.
   */
  baseline?(ctx: IMetaCtx): Record<string, number>;
}
