import { afterAll, describe, expect, test } from 'bun:test';

import {
  checkSecretNoInstall,
  createGithubActionsSecretNoInstallRule,
  type ISecretExemption,
} from './github-actions-secret-no-install.js';
import { createFixture, removeFixtures, runSync } from './test-support.js';

afterAll(removeFixtures);

const CACHE_EXEMPTION: readonly ISecretExemption[] = [
  {
    secret: 'CACHE_TOKEN',
    reason: 'the remote build cache credential every install job needs; its exposure is handled by a read-only cache on pull requests',
  },
];

/** A CI workflow with a workflow-level cache secret, four install jobs and one that also reads a deploy secret. */
const MULTI_JOB = `name: ci
on: push
env:
  CACHE_TOKEN: \${{ secrets.CACHE_TOKEN }}
jobs:
  quality:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - name: Audit repo settings
        run: bash scripts/audit-settings.sh
        env:
          GH_TOKEN: \${{ secrets.SETTINGS_TOKEN }}
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm install --frozen-lockfile
  test-unit:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm install --frozen-lockfile
  test-e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          pnpm install --frozen-lockfile
          pnpm e2e
`;

function check(text: string, exemptions: readonly ISecretExemption[] = CACHE_EXEMPTION) {
  return checkSecretNoInstall('ci.yml', text, exemptions);
}

function job(steps: string, extra = ''): string {
  return `name: x\non: push\n${extra}jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}`;
}

describe('github-actions-secret-no-install', () => {
  test('fails the one job that reads a secret after its install, with the cache secret exempt', () => {
    const violations = check(MULTI_JOB);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/Job `quality`/u);
    expect(violations[0]?.message ?? '').toMatch(/`SETTINGS_TOKEN`/u);
  });

  test('fails every install job on the workflow-level secret once it is not exempt', () => {
    const messages = check(MULTI_JOB, []).map((violation) => violation.message);
    const workflowLevel = messages.filter((message) => message.includes('workflow-level'));
    for (const id of ['quality', 'build', 'test-unit', 'test-e2e']) {
      expect(workflowLevel.some((message) => message.includes(`job \`${id}\``))).toBe(true);
    }
    expect(workflowLevel.every((message) => message.includes('`CACHE_TOKEN`'))).toBe(true);
  });

  test('fails a job that reads a secret in a step env and installs', () => {
    const violations = check(
      job(
        '      - run: pnpm install --frozen-lockfile\n' +
          '      - run: ./deploy.sh\n        env:\n          TOKEN: ${{ secrets.FOO }}\n',
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/`FOO`/u);
  });

  test('fails a secret passed through `with:` and an install in a block scalar', () => {
    const violations = check(
      job(
        '      - uses: some/action@abc\n        with:\n          token: ${{ secrets.NPM_TOKEN }}\n' +
          '      - run: |\n          set -e\n          npm ci\n',
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/line 12/u);
  });

  test('counts pnpm/action-setup run_install; a job with no secret, or a secret and no install, passes', () => {
    expect(
      check(
        job(
          '      - uses: pnpm/action-setup@abc\n        with:\n          run_install: true\n' +
            '      - run: echo\n        env:\n          X: ${{ secrets.X }}\n',
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(job('      - run: yarn install\n', ''), []).length +
        check(
          `name: x\non: push\njobs:\n  call:\n    uses: ./.github/workflows/y.yml\n    secrets: inherit\n  b:\n    runs-on: x\n    steps:\n      - run: bun add x\n`,
        ).length,
    ).toBe(0);
  });

  test('counts `secrets: inherit` in an install job as every secret', () => {
    const violations = check(
      `name: x\non: push\njobs:\n  b:\n    runs-on: x\n    secrets: inherit\n    steps:\n      - run: npm i\n`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/inherit \(every secret\)/u);
  });

  test('fails a workflow-level env secret for every job that installs', () => {
    const violations = check(
      job('      - run: pnpm install\n', 'env:\n  API_KEY: ${{ secrets.API_KEY }}\n'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/workflow-level `env:` exposes `API_KEY`/u);
  });

  test('passes a job that holds only GITHUB_TOKEN', () => {
    expect(
      check(
        job(
          '      - run: pnpm install\n      - run: gh api x\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
        ),
      ),
    ).toEqual([]);
  });

  test('passes a secret in a job of its own with no install', () => {
    const text =
      'name: x\non: push\njobs:\n' +
      '  build:\n    runs-on: x\n    steps:\n      - run: pnpm install --frozen-lockfile\n' +
      '  settings:\n    runs-on: x\n    steps:\n      - run: bash audit.sh\n        env:\n          GH_TOKEN: ${{ secrets.SETTINGS_TOKEN }}\n';
    expect(check(text)).toEqual([]);
  });

  test('ignores a step name or a comment that only mentions an install or a secret', () => {
    expect(
      check(
        job(
          '      - name: pnpm install is not run here\n        run: echo ok\n' +
            '      # env: ${{ secrets.OLD }}\n      - run: echo done # pnpm install\n',
        ),
      ),
    ).toEqual([]);
  });

  test('passes a workflow with no jobs block, or an empty one', () => {
    expect(check('name: x\non: push\n')).toEqual([]);
    expect(check('name: x\non: push\njobs:\n')).toEqual([]);
  });

  test('exempts a secret by name only: another secret in the same job still fails', () => {
    const steps =
      '      - run: pnpm install\n      - run: turbo build\n        env:\n          CACHE_TOKEN: ${{ secrets.CACHE_TOKEN }}\n';
    expect(check(job(steps))).toEqual([]);
    const both = check(job(`${steps}          OTHER: \${{ secrets.OTHER }}\n`));
    expect(both).toHaveLength(1);
    expect(both[0]?.message ?? '').toMatch(/`OTHER`/u);
    expect(both[0]?.message ?? '').not.toMatch(/CACHE_TOKEN/u);
  });

  test('refuses an exemption with no reason, and names the exempt secrets in its description', () => {
    expect(() =>
      createGithubActionsSecretNoInstallRule({ exemptSecrets: [{ secret: 'X', reason: ' ' }] }),
    ).toThrow(/needs a name and a reason/u);
    expect(createGithubActionsSecretNoInstallRule().description).not.toContain('exempt');
    expect(
      createGithubActionsSecretNoInstallRule({ exemptSecrets: CACHE_EXEMPTION }).description,
    ).toContain('exempt by name, each with its reason: CACHE_TOKEN');
  });

  test('runs over the repo workflows, reporting repo-relative paths', () => {
    const fixture = createFixture({
      '.github/workflows/ci.yml': job(
        '      - run: pnpm install\n      - run: x\n        env:\n          K: ${{ secrets.K }}\n',
      ),
      '.github/workflows/clean.yaml': job('      - run: pnpm install\n'),
    });
    const violations = runSync(createGithubActionsSecretNoInstallRule(), fixture.ctx());
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('.github/workflows/ci.yml');
  });
});
