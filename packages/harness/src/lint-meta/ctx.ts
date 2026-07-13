/**
 * The plain-Node {@link IMetaCtx} — the portable replacement for the Bun-coupled
 * context in `tools/lint-meta/cli.ts`. Uses `node:*` builtins ONLY (no Bun, no
 * network), so it runs under plain `node` in a stranger's CI:
 *  - `read`  — `node:fs` + LF-normalization (line-based rules match CI),
 *  - `exists`— `node:fs`,
 *  - `glob`  — `fs.globSync` (Node ≥ 22), the drop-in for Bun's `Glob`,
 *  - `exec`  — `node:child_process` `spawnSync`, which NEVER throws.
 *
 * The shape mirrors `createFakeCtx` (the in-memory test double), so rules are
 * ctx-injectable and this real ctx is behaviour-compatible with the fake.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { IMetaCtx } from './types.js';

/** Repo-relative path with forward slashes (the lint-meta internal convention). */
export function toPosixRel(rel: string): string {
  return rel.replace(/\\/g, '/');
}

/** Normalize text read from disk so line-based rules match CI (LF-only). */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** How much combined stdout+stderr a rule's `exec` may buffer (mirror the runner). */
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Build a real filesystem/exec {@link IMetaCtx} rooted at `root` (an absolute
 * path). Every read/glob is resolved against `root`; `exec` runs at `root`.
 */
export function createNodeCtx(root: string): IMetaCtx {
  return {
    root,
    read(rel) {
      const abs = path.join(root, toPosixRel(rel));
      if (!existsSync(abs)) return null;
      return normalizeText(readFileSync(abs, 'utf8'));
    },
    exists(rel) {
      return existsSync(path.join(root, toPosixRel(rel)));
    },
    glob(pattern) {
      // fs.globSync (Node >= 22) replaces Bun's `Glob().scanSync` — same
      // cwd-relative, forward-slashed match set for the file globs rules use.
      return Array.from(globSync(pattern, { cwd: root })).map(toPosixRel);
    },
    exec(cmd) {
      // spawnSync with `shell: true` mirrors the original `execSync` (a shell
      // command string). It never throws — a non-zero exit or a launch failure
      // surfaces as the returned `code`, never an exception.
      const res = spawnSync(cmd, {
        cwd: root,
        shell: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: EXEC_MAX_BUFFER,
      });
      return {
        code: typeof res.status === 'number' ? res.status : 1,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      };
    },
  };
}
