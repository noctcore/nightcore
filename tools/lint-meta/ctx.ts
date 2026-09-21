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
import { existsSync, readFileSync } from 'node:fs';
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
    glob(pattern) {
      return portableGlob(pattern, root);
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
