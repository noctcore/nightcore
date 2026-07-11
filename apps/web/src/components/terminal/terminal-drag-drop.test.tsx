import { afterEach, describe, expect, test } from 'vitest';

import { makeTerminalSession } from './_fixtures';
import { composeDroppedPaths, paneIdFromElement, planDrop } from './terminal-drag-drop';

describe('composeDroppedPaths (POSIX shell-escaping + multi-file join)', () => {
  test('a plain path is single-quote wrapped', () => {
    expect(composeDroppedPaths(['/Users/dev/file.txt'])).toBe("'/Users/dev/file.txt'");
  });

  test('a path with spaces is quoted as one argument', () => {
    expect(composeDroppedPaths(['/Users/dev/My Project/notes.md'])).toBe(
      "'/Users/dev/My Project/notes.md'",
    );
  });

  test("an embedded single quote is escaped '\\''", () => {
    // POSIX close-quote, escaped-quote, reopen: it's a wrap → '\'' → s.
    expect(composeDroppedPaths(["/Users/dev/it's a file.txt"])).toBe(
      "'/Users/dev/it'\\''s a file.txt'",
    );
  });

  test('unicode passes through the single-quote wrap untouched', () => {
    expect(composeDroppedPaths(['/Users/dev/café/résumé.pdf'])).toBe(
      "'/Users/dev/café/résumé.pdf'",
    );
  });

  test('multiple files join space-separated, each independently escaped', () => {
    expect(composeDroppedPaths(['/a/one.txt', '/b/two three.txt', "/c/f'our.txt"])).toBe(
      "'/a/one.txt' '/b/two three.txt' '/c/f'\\''our.txt'",
    );
  });

  test('a path that is itself a space stays quoted (shell metachars never leak bare)', () => {
    // Wrapping is unconditional, so `;`, `&&`, `$(...)`, globs etc. can never execute.
    expect(composeDroppedPaths(['/a/$(rm -rf ~) && echo hi'])).toBe(
      "'/a/$(rm -rf ~) && echo hi'",
    );
  });

  test('empty entries are dropped; an all-empty input yields the empty string', () => {
    expect(composeDroppedPaths(['', '/a/x.txt', ''])).toBe("'/a/x.txt'");
    expect(composeDroppedPaths([''])).toBe('');
    expect(composeDroppedPaths([])).toBe('');
  });
});

describe('paneIdFromElement (hit-test → the pane under the cursor)', () => {
  const roots: HTMLElement[] = [];
  afterEach(() => {
    for (const el of roots.splice(0)) el.remove();
  });

  function mountPane(sessionId: string): { root: HTMLElement; inner: HTMLElement } {
    const root = document.createElement('div');
    root.dataset.sessionId = sessionId;
    const inner = document.createElement('div');
    const leaf = document.createElement('span');
    inner.appendChild(leaf);
    root.appendChild(inner);
    document.body.appendChild(root);
    roots.push(root);
    return { root, inner: leaf };
  }

  test('a descendant of a pane root resolves to its session id', () => {
    const { inner } = mountPane('sess-a');
    expect(paneIdFromElement(inner)).toBe('sess-a');
  });

  test('the pane root itself resolves to its own id (closest is inclusive)', () => {
    const { root } = mountPane('sess-b');
    expect(paneIdFromElement(root)).toBe('sess-b');
  });

  test('an element outside every pane → null (drop between/outside panes)', () => {
    const stray = document.createElement('div');
    document.body.appendChild(stray);
    expect(paneIdFromElement(stray)).toBeNull();
    stray.remove();
  });

  test('a null hit (elementFromPoint miss) → null', () => {
    expect(paneIdFromElement(null)).toBeNull();
  });
});

describe('planDrop (fail-soft drop → write decision)', () => {
  const zsh = makeTerminalSession({ id: 'sess-a', shell: '/bin/zsh' });
  const bash = makeTerminalSession({ id: 'sess-b', shell: '/usr/bin/bash' });
  const pwsh = makeTerminalSession({ id: 'sess-c', shell: 'C:\\Program Files\\PowerShell\\pwsh.exe' });
  const sessions = [zsh, bash, pwsh];

  test('a POSIX pane → the target id + the escaped path text (no newline)', () => {
    expect(planDrop(['/a/file.txt'], 'sess-a', sessions)).toEqual({
      id: 'sess-a',
      text: "'/a/file.txt'",
    });
  });

  test('multi-file drop → space-separated escaped paths for that pane', () => {
    expect(planDrop(['/a/one.txt', '/b/two.txt'], 'sess-b', sessions)).toEqual({
      id: 'sess-b',
      text: "'/a/one.txt' '/b/two.txt'",
    });
  });

  test('drop outside any pane (null id) → no-op null', () => {
    expect(planDrop(['/a/file.txt'], null, sessions)).toBeNull();
  });

  test('drop onto an unknown/closed session → no-op null', () => {
    expect(planDrop(['/a/file.txt'], 'ghost', sessions)).toBeNull();
  });

  test('drop onto a NON-POSIX (PowerShell) pane → no-op null (v1 is POSIX-only)', () => {
    expect(planDrop(['/a/file.txt'], 'sess-c', sessions)).toBeNull();
  });

  test('an empty path list → no-op null (nothing to type)', () => {
    expect(planDrop([], 'sess-a', sessions)).toBeNull();
    expect(planDrop([''], 'sess-a', sessions)).toBeNull();
  });
});
