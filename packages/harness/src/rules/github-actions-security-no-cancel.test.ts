import { afterAll, describe, expect, test } from 'bun:test';

import {
  checkSecurityWorkflowNoCancel,
  createGithubActionsSecurityNoCancelRule,
} from './github-actions-security-no-cancel.js';
import { createFixture, removeFixtures, runSync } from './test-support.js';

afterAll(removeFixtures);

function check(name: string, text: string) {
  return checkSecurityWorkflowNoCancel(`.github/workflows/${name}`, text);
}

/** A secret-scanning workflow that cancels, with a group shared per ref. */
const OLD_SHAPE = `name: security-secrets

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: security-secrets-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - run: gitleaks git .
`;

/** The fix: no block, with a comment that quotes the forbidden shape. */
const FIXED_SHAPE = `name: security-secrets

on:
  push:
    branches: [main]

# Deliberately NO \`concurrency\` block. \`cancel-in-progress:
# true\` lets a newer push cancel an older run; \`concurrency: group: x\` would let
# a new run replace a pending one.

permissions:
  contents: read

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - run: gitleaks git .
`;

function withConcurrency(block: string, name = 'security-secrets.yml') {
  return check(name, `name: x\non: push\n${block}\njobs:\n  scan:\n    runs-on: x\n`);
}

describe('github-actions-security-no-cancel', () => {
  test('reports the old shape: cancelling, and a group shared per ref', () => {
    const violations = check('security-secrets.yml', OLD_SHAPE);

    expect(violations).toHaveLength(2);
    for (const violation of violations) {
      expect(violation.rule).toBe('github-actions-security-no-cancel');
    }
    expect(violations[0]?.message ?? '').toMatch(/Line 9: .*`cancel-in-progress: true`/u);
    expect(violations[1]?.message ?? '').toMatch(
      /Line 9: .*group `security-secrets-\$\{\{ github\.ref \}\}` is not keyed on the commit/u,
    );
  });

  test('passes the fixed shape, even though its comment quotes cancel-in-progress: true', () => {
    expect(check('security-secrets.yml', FIXED_SHAPE)).toEqual([]);
  });

  test('reports a group that is not commit-keyed even when it does not cancel', () => {
    const violations = withConcurrency(
      'concurrency:\n  group: security-secrets\n  cancel-in-progress: false',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/REPLACES the pending one/u);
  });

  test('reports a block that declares no group at all', () => {
    const violations = withConcurrency('concurrency:\n  cancel-in-progress: false');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/group is not declared/u);
  });

  test('passes a non-cancelling group keyed on github.sha or github.run_id', () => {
    for (const key of ['github.sha', 'github.run_id', 'github.event.pull_request.head.sha']) {
      expect(
        withConcurrency(
          `concurrency:\n  group: security-secrets-\${{ ${key} }}\n  cancel-in-progress: false`,
        ),
      ).toEqual([]);
    }
  });

  test('still reports cancel-in-progress: true on a commit-keyed group', () => {
    const violations = withConcurrency(
      'concurrency:\n  group: s-${{ github.sha }}\n  cancel-in-progress: true',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message ?? '').toMatch(/`cancel-in-progress: true`/u);
  });

  test('treats a non-literal cancel-in-progress expression as cancelling', () => {
    expect(
      withConcurrency(
        "concurrency:\n  group: s-${{ github.sha }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      ),
    ).toHaveLength(1);
  });

  test('reads the flow-mapping and scalar forms of the concurrency key', () => {
    expect(
      withConcurrency(
        'concurrency: { group: security-secrets-${{ github.ref }}, cancel-in-progress: true }',
      ),
    ).toHaveLength(2);
    expect(
      withConcurrency('concurrency: { cancel-in-progress: false, group: s-${{ github.sha }} }'),
    ).toEqual([]);
    expect(withConcurrency('concurrency: security-secrets')).toHaveLength(1);
  });

  test('reads a job-level concurrency block too', () => {
    expect(
      check(
        'security-secrets.yml',
        'jobs:\n  scan:\n    runs-on: x\n    concurrency:\n      group: scan\n      cancel-in-progress: true\n',
      ),
    ).toHaveLength(2);
  });

  test('flags a workflow that runs gitleaks even when it is not named security-*', () => {
    expect(
      check(
        'secrets.yml',
        'concurrency:\n  group: g-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  scan:\n    runs-on: x\n    steps:\n      - run: gitleaks git .\n',
      ),
    ).toHaveLength(2);
    expect(
      check(
        'scan.yml',
        'concurrency:\n  group: g\njobs:\n  scan:\n    steps:\n      - uses: gitleaks/gitleaks-action@v2\n',
      ),
    ).toHaveLength(1);
  });

  test('leaves an ordinary workflow alone, including one that cancels superseded runs', () => {
    expect(
      check(
        'ci.yml',
        'concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  test:\n    steps:\n      - run: echo gitleaks is mentioned in a name only\n',
      ),
    ).toEqual([]);
  });

  test('passes a security workflow with no concurrency block at all', () => {
    expect(check('security-deps.yml', 'name: deps\njobs: {}\n')).toEqual([]);
  });

  test('takes the security workflow name pattern from the options', () => {
    const fixture = createFixture({
      '.github/workflows/scan-secrets.yml': OLD_SHAPE.replace('gitleaks git .', 'trufflehog .'),
      '.github/workflows/security-other.yml': OLD_SHAPE.replace('gitleaks git .', 'echo'),
    });
    const rule = createGithubActionsSecurityNoCancelRule({ securityWorkflowName: /^scan-/u });
    const violations = runSync(rule, fixture.ctx());
    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.file === '.github/workflows/scan-secrets.yml')).toBe(
      true,
    );
  });

  test('runs over every workflow file in the repo', () => {
    const fixture = createFixture({
      '.github/workflows/security-secrets.yml': OLD_SHAPE,
      '.github/workflows/ci.yml': 'name: ci\n',
    });

    expect(runSync(createGithubActionsSecurityNoCancelRule(), fixture.ctx())).toHaveLength(2);
  });
});
