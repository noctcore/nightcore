import { describe, expect, test } from 'vitest';

import { makeTerminalTask } from './_fixtures';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  composeClaudeLaunch,
  composeClaudeResume,
  composeTaskContext,
  frameBracketedPaste,
  isPosixShell,
  shellQuotePosix,
  taskFilePath,
} from './terminal-inject';

// Pure-string tests (no PTY, no bridge) — they pin the injection mechanics the
// USER-ONLY seam relies on: bracketed-paste framing, no trailing newline, POSIX
// shell-escaping, and the exact on-disk task-file path.

describe('taskFilePath', () => {
  test('joins the POSIX project root with the .nightcore/tasks convention', () => {
    expect(taskFilePath('/Users/dev/nightcore', 'task-42')).toBe(
      '/Users/dev/nightcore/.nightcore/tasks/task-42.json',
    );
  });
  test('joins a Windows project root with backslashes', () => {
    expect(taskFilePath('C:\\dev\\nightcore', 'task-9')).toBe(
      'C:\\dev\\nightcore\\.nightcore\\tasks\\task-9.json',
    );
  });
  test('tolerates a trailing separator on the root', () => {
    expect(taskFilePath('/repo/', 'x')).toBe('/repo/.nightcore/tasks/x.json');
  });
});

describe('composeTaskContext', () => {
  test('lays out title, description, and the task-file path', () => {
    const task = makeTerminalTask({ id: 'task-1', title: 'Fix login', description: 'Handle 401s.' });
    expect(composeTaskContext(task, '/repo')).toBe(
      'Fix login\n\nHandle 401s.\n\nTask file: /repo/.nightcore/tasks/task-1.json',
    );
  });
  test('omits the description block when empty and the path when no project', () => {
    const task = makeTerminalTask({ id: 'task-2', title: 'Bare', description: '   ' });
    expect(composeTaskContext(task, null)).toBe('Bare\n');
  });
});

describe('frameBracketedPaste', () => {
  test('wraps in ESC[200~ … ESC[201~ with NO trailing newline (decision 2)', () => {
    const framed = frameBracketedPaste('multi\nline');
    expect(framed).toBe(`${BRACKETED_PASTE_START}multi\nline${BRACKETED_PASTE_END}`);
    expect(framed.endsWith('\n')).toBe(false);
    expect(BRACKETED_PASTE_START).toBe('\x1b[200~');
    expect(BRACKETED_PASTE_END).toBe('\x1b[201~');
  });
});

describe('shellQuotePosix', () => {
  test('single-quotes and escapes embedded quotes', () => {
    expect(shellQuotePosix('/a/b c')).toBe("'/a/b c'");
    expect(shellQuotePosix("/it's/here")).toBe("'/it'\\''s/here'");
  });
});

describe('claude launch/resume composition', () => {
  test('launch cds + runs claude, ending with a carriage return', () => {
    expect(composeClaudeLaunch('/repo', { yolo: false })).toBe("cd '/repo' && claude\r");
  });
  test('YOLO appends --dangerously-skip-permissions', () => {
    expect(composeClaudeLaunch('/repo', { yolo: true })).toBe(
      "cd '/repo' && claude --dangerously-skip-permissions\r",
    );
  });
  test('resume uses --continue', () => {
    expect(composeClaudeResume('/repo', { yolo: false })).toBe(
      "cd '/repo' && claude --continue\r",
    );
    expect(composeClaudeResume('/repo', { yolo: true })).toBe(
      "cd '/repo' && claude --continue --dangerously-skip-permissions\r",
    );
  });
});

describe('isPosixShell', () => {
  test('accepts known POSIX shells', () => {
    expect(isPosixShell('/bin/zsh')).toBe(true);
    expect(isPosixShell('/bin/bash')).toBe(true);
    expect(isPosixShell('/usr/bin/fish')).toBe(true);
  });
  test('rejects PowerShell / cmd (the launch button is POSIX-gated in v1)', () => {
    expect(isPosixShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(false);
    expect(isPosixShell('C:\\Windows\\System32\\cmd.exe')).toBe(false);
  });
});
