/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateWorkspaceConfinement,
  WORKSPACE_CONFINEMENT_RULE_ID,
} from './workspace-confinement.js';

// The reported bug: cwd is the task worktree, nested inside the main checkout, so
// the main repo root is a trivial parent of cwd.
const WORKTREE = '/repo/.nightcore/worktrees/task-1';
const MAIN = '/repo';

describe('evaluateWorkspaceConfinement — file mutations', () => {
  test.each(['Write', 'Edit', 'MultiEdit'])(
    'denies %s targeting an absolute path in the parent (main) checkout',
    (tool) => {
      const verdict = evaluateWorkspaceConfinement(
        tool,
        { file_path: `${MAIN}/apps/web/src/components/board/status.ts` },
        WORKTREE,
      );
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
      // The reason names both the working dir and the offending target so the
      // agent can adapt.
      expect(verdict.reason).toContain(WORKTREE);
      expect(verdict.reason).toContain(`${MAIN}/apps/web`);
    },
  );

  test('denies NotebookEdit outside cwd (notebook_path key)', () => {
    const verdict = evaluateWorkspaceConfinement(
      'NotebookEdit',
      { notebook_path: `${MAIN}/analysis.ipynb` },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
  });

  test('allows an absolute path INSIDE cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Edit',
        { file_path: `${WORKTREE}/apps/web/x.ts` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('resolves a relative path against cwd → allowed', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Write',
        { file_path: 'apps/web/x.ts' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows a write into the OS temp dir (scratch files)', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Write',
        { file_path: path.join(os.tmpdir(), 'nightcore-scratch.txt') },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('a sibling whose name PREFIXES cwd is not treated as inside (trailing-sep guard)', () => {
    // `/repo/.nightcore/worktrees/task-1-evil` must NOT count as inside task-1.
    expect(
      evaluateWorkspaceConfinement(
        'Edit',
        { file_path: `${WORKTREE}-evil/x.ts` },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test('an empty cwd disables the gate (nothing to confine to)', () => {
    expect(
      evaluateWorkspaceConfinement('Edit', { file_path: '/anywhere/x.ts' }, '')
        .denied,
    ).toBe(false);
  });

  test('leaves non-mutation tools alone (reads are not confined)', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${MAIN}/package.json` },
        WORKTREE,
      ).denied,
    ).toBe(false);
    expect(
      evaluateWorkspaceConfinement('Grep', { pattern: 'x' }, WORKTREE).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — fail-closed on unreadable target', () => {
  test.each([
    ['missing key', {}],
    ['non-string value', { file_path: 123 }],
    ['empty string', { file_path: '' }],
    ['null input', null],
  ] as const)(
    'DENIES a known mutation tool (Edit) whose target is unreadable (%s)',
    (_label, input) => {
      const verdict = evaluateWorkspaceConfinement('Edit', input, WORKTREE);
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
    },
  );
});

describe('evaluateWorkspaceConfinement — temp allowance', () => {
  const TMP_REPO = path.join(os.tmpdir(), 'nc-scratch');
  const TMP_WORKTREE = path.join(TMP_REPO, '.nightcore/worktrees/task-1');

  test('a write to the OS temp dir is allowed when cwd is NOT under temp', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Write',
        { file_path: path.join(os.tmpdir(), 'scratch.txt') },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('the temp allowance is DROPPED when cwd itself is under temp (no fail-open)', () => {
    // cwd is a worktree hosted under the OS temp dir (the dogfood scratch repo).
    // A write to the scratch repo's MAIN tree (a temp sibling of cwd) must still
    // be denied — otherwise the temp allowance would swallow the whole repo.
    const verdict = evaluateWorkspaceConfinement(
      'Edit',
      { file_path: path.join(TMP_REPO, 'apps/web/status.ts') },
      TMP_WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    // …but a write INSIDE that temp-hosted cwd is still allowed.
    expect(
      evaluateWorkspaceConfinement(
        'Edit',
        { file_path: path.join(TMP_WORKTREE, 'apps/web/status.ts') },
        TMP_WORKTREE,
      ).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — Bash cd escape (best-effort)', () => {
  test('denies an absolute `cd` to a path outside cwd', () => {
    const verdict = evaluateWorkspaceConfinement(
      'Bash',
      { command: 'cd /repo && bun run typecheck' },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
    expect(verdict.reason).toContain(MAIN);
  });

  test('denies `pushd` to an absolute path outside cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'pushd /etc' },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test('allows a relative `cd` (stays within cwd subtree)', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'cd apps/web && bun test' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows an absolute `cd` INSIDE cwd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: `cd ${WORKTREE}/apps/web && ls` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('does not flag a dynamic cd target it cannot resolve lexically', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'cd "$(mktemp -d)" && touch x' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows a benign Bash command with no cd', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Bash',
        { command: 'bun run typecheck' },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });
});
