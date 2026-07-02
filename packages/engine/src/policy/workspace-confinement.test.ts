/// <reference types="bun" />
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  evaluateWorkspaceConfinement,
  SENSITIVE_READ_RULE_ID,
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

  test('a non-secret read outside cwd stays allowed (denylist, not blanket confinement)', () => {
    // Reads are NOT blanket-confined to cwd — only known secret targets are denied.
    // A plain source/manifest read in the parent checkout must still work (e.g.
    // hoisted node_modules / sibling packages in worktree mode).
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${MAIN}/package.json` },
        WORKTREE,
      ).denied,
    ).toBe(false);
    // Grep/Glob are not inspected by the read guard at all.
    expect(
      evaluateWorkspaceConfinement('Grep', { pattern: 'x' }, WORKTREE).denied,
    ).toBe(false);
  });
});

describe('evaluateWorkspaceConfinement — sensitive read guard', () => {
  const HOME = os.homedir();

  test.each([
    ['AWS credentials', path.join(HOME, '.aws/credentials')],
    ['SSH private key', path.join(HOME, '.ssh/id_rsa')],
    ['SSH ed25519 key', path.join(HOME, '.ssh/id_ed25519')],
    ['Claude credential file', path.join(HOME, '.claude.json')],
    ['gcloud config', path.join(HOME, '.config/gcloud/credentials.db')],
    ['gh config', path.join(HOME, '.config/gh/hosts.yml')],
    ['npm token file', path.join(HOME, '.npmrc')],
    ['git credentials', path.join(HOME, '.git-credentials')],
    ['docker config', path.join(HOME, '.docker/config.json')],
  ])('denies Read of a home credential store (%s)', (_label, file) => {
    const verdict = evaluateWorkspaceConfinement('Read', { file_path: file }, WORKTREE);
    expect(verdict.denied).toBe(true);
    expect(verdict.ruleId).toBe(SENSITIVE_READ_RULE_ID);
    expect(verdict.reason).toContain(WORKTREE);
  });

  test("denies Read of another project's .env (a portable secret outside the run roots)", () => {
    // A sibling checkout's env — the exact cross-project leak the finding names.
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: '/some/other/project/.env' },
        WORKTREE,
      ).denied,
    ).toBe(true);
    // The MAIN checkout's .env (outside the worktree cwd) is likewise refused.
    expect(
      evaluateWorkspaceConfinement('Read', { file_path: `${MAIN}/.env` }, WORKTREE)
        .denied,
    ).toBe(true);
    // …incl. environment-specific variants.
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${MAIN}/.env.production` },
        WORKTREE,
      ).denied,
    ).toBe(true);
  });

  test("allows Read of the task's OWN in-cwd .env (its project's env is fine)", () => {
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${WORKTREE}/.env` },
        WORKTREE,
      ).denied,
    ).toBe(false);
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: `${WORKTREE}/apps/web/.env.local` },
        WORKTREE,
      ).denied,
    ).toBe(false);
  });

  test('allows Read of a non-secret .env template outside cwd (.env.example)', () => {
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      expect(
        evaluateWorkspaceConfinement(
          'Read',
          { file_path: `${MAIN}/${name}` },
          WORKTREE,
        ).denied,
      ).toBe(false);
    }
  });

  test('denies a `..` traversal that normalizes into a home credential store', () => {
    // Lexical resolution normalizes `..` before the check, so it can't be dodged.
    const viaTraversal = `${HOME}/.aws/nested/../credentials`;
    expect(
      evaluateWorkspaceConfinement('Read', { file_path: viaTraversal }, WORKTREE)
        .denied,
    ).toBe(true);
  });

  test('an unreadable/absent Read target fails OPEN (guard is a denylist)', () => {
    // Unlike the mutation side (fail-closed), a read with no target degrades to
    // allow — the guard only ever denies targets it positively recognizes.
    expect(evaluateWorkspaceConfinement('Read', {}, WORKTREE).denied).toBe(false);
    expect(
      evaluateWorkspaceConfinement('Read', { file_path: 123 }, WORKTREE).denied,
    ).toBe(false);
  });

  test('an empty cwd disables the read guard too', () => {
    expect(
      evaluateWorkspaceConfinement(
        'Read',
        { file_path: path.join(HOME, '.aws/credentials') },
        '',
      ).denied,
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
