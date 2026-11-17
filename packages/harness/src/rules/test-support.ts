/**
 * Test-only fixture helper for the rule tests: every test writes its own
 * throwaway repo under the OS temp dir and runs the rule against a real
 * `createNodeCtx` over it, so a green result means the rule behaves, not that
 * some live tree happens to be clean. No `src` entry point imports this file,
 * so it never ships in `dist`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNodeCtx } from '../lint-meta/ctx.js';
import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';

export interface IFixture {
  readonly root: string;
  /** Write (or overwrite) files, keyed by repo-relative POSIX path. */
  write(files: Readonly<Record<string, string>>): void;
  ctx(): IMetaCtx;
}

const ROOTS: string[] = [];

/** A fresh fixture repo; call {@link removeFixtures} from an `afterAll`. */
export function createFixture(files: Readonly<Record<string, string>> = {}): IFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-rule-fixture-'));
  ROOTS.push(root);
  const write = (entries: Readonly<Record<string, string>>): void => {
    for (const [rel, content] of Object.entries(entries)) {
      const abs = path.join(root, ...rel.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  };
  write(files);
  return { root, write, ctx: () => createNodeCtx(root) };
}

/** Delete every fixture this process created. */
export function removeFixtures(): void {
  for (const root of ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run a rule's sync pass; a rule without one fails loudly instead of returning []. */
export function runSync(rule: IMetaRule, ctx: IMetaCtx): IViolation[] {
  if (rule.run === undefined) {
    throw new Error(`Rule "${rule.id}" has no sync pass`);
  }
  return rule.run(ctx);
}

/** Every message of a violation list, in order. */
export function messages(violations: readonly IViolation[]): string[] {
  return violations.map((violation) => violation.message);
}
