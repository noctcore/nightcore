/**
 * The PORTABLE lint-meta contract — the types a target repo's generated
 * `lint-meta-rule` artifacts implement and import from `@noctcore/harness`.
 *
 * This is an owned COPY of the Nightcore-internal `tools/lint-meta/types.ts`
 * (the engine that enforces what ESLint cannot reach: cross-file contracts,
 * non-JS files, config parity). It is reproduced here, not imported, so the
 * published package carries the whole contract with ZERO runtime dependency on
 * the monorepo — a generated rule in a stranger's repo does
 * `import type { IMetaRule } from '@noctcore/harness'` and nothing else.
 *
 * Rules are pure functions of an {@link IMetaCtx} and return {@link IViolation}s;
 * the runner exits non-zero when any `ciCritical` rule reports one (or throws).
 */

export interface IMetaCtx {
  /** Absolute repo root the rule reads relative to. */
  readonly root: string;
  /** Read a repo-relative file (LF-normalized), or `null` if it does not exist. */
  read(rel: string): string | null;
  /** Whether a repo-relative path exists. */
  exists(rel: string): boolean;
  /** Glob repo-relative paths (cwd = {@link root}). */
  glob(pattern: string): string[];
  /** Run a shell command at {@link root}; never throws. */
  exec(cmd: string): { code: number; stdout: string; stderr: string };
}

export interface IViolation {
  file: string;
  rule: string;
  message: string;
  /**
   * 1-indexed source location, when the rule can pinpoint one. Optional and
   * additive: the text reporter ignores it (it surfaces `file`/`rule`/`message`
   * only), so a rule may omit it.
   */
  line?: number;
  column?: number;
}

export interface IMetaRule {
  id: string;
  category: 'config' | 'source-text' | 'supply-chain' | 'ci' | 'testing';
  description: string;
  /** When true, a violation fails CI (the runner exits non-zero). */
  ciCritical?: boolean;
  run(ctx: IMetaCtx): IViolation[];
  /**
   * Ratcheting rules implement this to snapshot the CURRENT offenders as a frozen
   * baseline (a flat `metric-key → number` map). A rule's `run` then grandfathers
   * any offender still within its recorded value (see `baseline.ts`). Omit for
   * strict rules.
   */
  baseline?(ctx: IMetaCtx): Record<string, number>;
}
