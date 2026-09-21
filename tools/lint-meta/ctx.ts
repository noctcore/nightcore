// @ts-check
/**
 * The real filesystem/exec context the CLI hands every meta rule, rooted at
 * `root`. Split out of `cli.ts` so it can be exercised against a real tree in a
 * test (a fake ctx cannot show what the glob engine does on disk).
 *
 * `glob` goes through `@noctcore/harness`'s `portableGlob` instead of Bun's
 * `Glob`: Bun's globbing skips every dot-directory segment, even a literal one,
 * so `.github/workflows/*.yml` matched nothing and a rule globbing it would pass
 * forever. `portableGlob` walks with Node's `fs.globSync` rules under Bun and
 * throws on syntax it does not implement rather than matching nothing. It is
 * imported by relative path, like `tools/codegen` reads `packages/contracts`,
 * because the harness only publishes its type surface from the barrel.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { portableGlob } from '../../packages/harness/src/lint-meta/glob.ts';
import { normalizeText, toPosixRel } from './paths';
import type { IMetaCtx } from './types';

/** Build the live ctx: reads/globs resolve against `root`, `exec` runs there. */
export function createCtx(root: string): IMetaCtx {
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
    /*
     * Files only. `portableGlob` faithfully reproduces Node's `fs.globSync`,
     * which returns matching DIRECTORIES as well as files; Bun's `Glob`, which
     * this replaced, returned only files. That difference is not academic here:
     * vitest writes its image snapshots into directories literally named
     * `<name>.test.tsx`, so `components/**\/*.tsx` matches 54 directories, and
     * every rule that globs then reads threw `EISDIR` the moment the walker
     * changed.
     *
     * A lint rule globs in order to read, so a directory in the result is never
     * useful and always a latent crash. Filtering here keeps that guarantee for
     * every rule rather than asking each one to remember.
     */
    glob(pattern) {
      return portableGlob(pattern, root).filter((rel) => {
        try {
          return statSync(path.join(root, rel)).isFile();
        } catch {
          return false;
        }
      });
    },
    exec(cmd) {
      try {
        const stdout = execSync(cmd, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, stdout, stderr: '' };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    },
  };
}
