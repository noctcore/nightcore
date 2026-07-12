#!/usr/bin/env bun
/**
 * Prebuild dist cleaner — wipes the `dist/` output AND the incremental
 * `tsconfig.tsbuildinfo` of every project in the root `tsc -b` graph before a
 * fresh build, so a renamed or deleted source file can't leave a stale
 * `.js`/`.d.ts` "ghost" behind that shadows the current tree.
 *
 * WHY not `tsc -b --clean`: the incremental builder only deletes outputs it still
 * tracks. When a source file is removed, neither `tsc -b` nor `tsc -b --clean`
 * removes its orphaned emit (verified) — exactly how `packages/engine/dist/`
 * accumulated pre-refactor ghosts (issue #178). A full directory wipe is the only
 * reliable guard.
 *
 * WHY the `.tsbuildinfo` must go too: it lives at each package root (NOT inside
 * `dist/`), so wiping `dist/` alone leaves a buildinfo that reports "up to date".
 * The next `tsc -b` then trusts it and skips re-emitting into the now-empty `dist/`,
 * leaving the package with no build output. Removing the buildinfo forces the clean
 * full re-emit this step is meant to guarantee. (`typecheck` — a separate `tsc -b`
 * with no prebuild — keeps its buildinfo and stays incremental.)
 *
 * `fs.rmSync` keeps it cross-platform (no shell `rm -rf`, which the Windows release
 * build would choke on) and dependency-free. Scoped to the `tsc -b` projects ONLY:
 * `packages/eslint-plugin/dist` (tsup) and `apps/web/dist` (vite) are built by other
 * tools and must not be wiped here. Keep this list in sync with `tsconfig.json`'s
 * `references`.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

const TSC_BUILD_PROJECT_DIRS = [
  'packages/contracts',
  'packages/session-fold',
  'packages/shared',
  'packages/config',
  'packages/storage',
  'packages/engine',
  'apps/sidecar',
];

for (const dir of TSC_BUILD_PROJECT_DIRS) {
  rmSync(path.join(ROOT, dir, 'dist'), { recursive: true, force: true });
  rmSync(path.join(ROOT, dir, 'tsconfig.tsbuildinfo'), { force: true });
}
