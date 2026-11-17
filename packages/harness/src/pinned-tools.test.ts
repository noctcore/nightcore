import { describe, expect, test } from 'bun:test';

import * as pinnedTools from './pinned-tools.js';

describe('@noctcore/harness/pinned-tools', () => {
  test('exports the route, fetch, gitleaks and node entry points a repo CLI needs', () => {
    for (const name of [
      'chooseRoute',
      'runLinter',
      'linterVerdict',
      'exitCodeFor',
      'parseVersion',
      'fetchPinned',
      'placeBinary',
      'runGitleaks',
      'pinnedGitleaksVersion',
      'nodeRunDeps',
      'nodeGitleaksDeps',
      'nodeFetchDeps',
    ] as const) {
      expect(typeof pinnedTools[name]).toBe('function');
    }
  });

  test('names each workflow linter by its own pin', () => {
    expect(pinnedTools.WORKFLOW_LINTERS.zizmor).toBe(pinnedTools.ZIZMOR);
    expect(pinnedTools.WORKFLOW_LINTERS.actionlint).toBe(pinnedTools.ACTIONLINT);
    expect(pinnedTools.ACTIONLINT.needs).toContain(pinnedTools.SHELLCHECK);
  });
});
