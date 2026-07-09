import type { GauntletResult, StructureLockResult } from '@/lib/bridge';

/** A passing readiness-gauntlet result (typecheck → lint → test all green). */
export const GAUNTLET_PASSED: GauntletResult = {
  passed: true,
  steps: [
    { name: 'typecheck', command: 'bun run typecheck', status: 'passed', exitCode: 0 },
    { name: 'lint', command: 'bun run lint', status: 'passed', exitCode: 0 },
    { name: 'test', command: 'bun run test', status: 'passed', exitCode: 0 },
  ],
};

/** A failing gauntlet — `test` fails, so it is the failed step and lint never
 *  ran (the runner stops at the first non-zero exit). */
export const GAUNTLET_FAILED: GauntletResult = {
  passed: false,
  failedStep: 'test',
  steps: [
    { name: 'typecheck', command: 'bun run typecheck', status: 'passed', exitCode: 0 },
    { name: 'test', command: 'bun run test', status: 'failed', exitCode: 1 },
    { name: 'lint', command: 'bun run lint', status: 'skipped' },
  ],
};

/** A passing Structure-Lock Gauntlet — the project's own generated harness checks
 *  (custom lint-plugin + architecture boundary) all pass. */
export const STRUCTURE_LOCK_PASSED: StructureLockResult = {
  passed: true,
  checks: [
    {
      name: 'folder-per-component',
      kind: 'lint-plugin',
      command: 'npx eslint .',
      status: 'passed',
      exitCode: 0,
    },
    {
      name: 'no-cross-feature-imports',
      kind: 'dependency-cruiser',
      command: 'npx depcruise src',
      status: 'passed',
      exitCode: 0,
    },
  ],
};

/** A failing Structure-Lock Gauntlet — the generated lint plugin fails, so it is
 *  the failed check and the later boundary check never ran (stop-at-first). */
export const STRUCTURE_LOCK_FAILED: StructureLockResult = {
  passed: false,
  failedCheck: 'folder-per-component',
  checks: [
    {
      name: 'folder-per-component',
      kind: 'lint-plugin',
      command: 'npx eslint .',
      status: 'failed',
      exitCode: 1,
      output: 'error  Component must live in its own folder  nightcore/folder-per-component',
    },
    {
      name: 'no-cross-feature-imports',
      kind: 'dependency-cruiser',
      command: 'npx depcruise src',
      status: 'skipped',
    },
  ],
};
