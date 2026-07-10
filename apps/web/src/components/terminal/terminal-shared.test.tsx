import { describe, expect, test } from 'vitest';

import { displayPath, terminalLabel } from './terminal-shared';

// Pure-string tests (no PTY, no host dependence) — these prove the Windows
// verbatim-prefix display fix on any CI host, including the Linux/macOS boxes that
// never produce a `\\?\` path themselves.

describe('displayPath', () => {
  test('strips the Windows verbatim drive prefix (the reported picker bug)', () => {
    expect(displayPath('\\\\?\\X:\\dev\\nightcore')).toBe('X:\\dev\\nightcore');
  });

  test('rewrites a verbatim UNC prefix to a normal UNC path', () => {
    expect(displayPath('\\\\?\\UNC\\server\\share\\wt')).toBe('\\\\server\\share\\wt');
  });

  test('passes POSIX paths through untouched', () => {
    expect(displayPath('/Users/dev/nightcore')).toBe('/Users/dev/nightcore');
    expect(displayPath('/bin/zsh')).toBe('/bin/zsh');
  });

  test('passes already-clean Windows paths through untouched', () => {
    expect(displayPath('C:\\dev\\nightcore')).toBe('C:\\dev\\nightcore');
  });

  test('is idempotent (prettifying a prettified path is a no-op)', () => {
    const once = displayPath('\\\\?\\X:\\dev\\nightcore');
    expect(displayPath(once)).toBe(once);
  });
});

describe('terminalLabel', () => {
  test('takes the last segment of a POSIX path', () => {
    expect(terminalLabel('/Users/dev/nightcore')).toBe('nightcore');
  });

  test('takes the last segment of a Windows path (splits on both separators)', () => {
    expect(terminalLabel('X:\\dev\\nightcore')).toBe('nightcore');
  });

  test('strips the verbatim prefix before labeling a Windows worktree cwd', () => {
    expect(
      terminalLabel('\\\\?\\X:\\dev\\nightcore\\.nightcore\\worktrees\\task-42'),
    ).toBe('task-42');
  });
});
