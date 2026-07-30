import { expect, test } from 'vitest';

import { classifyKeyEvent, type KeyEventLike } from './terminal-keymap';

/** Build a keydown-like event with sane defaults. */
function key(over: Partial<KeyEventLike>): KeyEventLike {
  return {
    type: 'keydown',
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

test('a plain keystroke passes through to the PTY', () => {
  expect(classifyKeyEvent(key({ key: 'a' }), true)).toBe('passthrough');
  expect(classifyKeyEvent(key({ key: 'a' }), false)).toBe('passthrough');
});

test('non-keydown events always pass through', () => {
  expect(classifyKeyEvent(key({ type: 'keyup', metaKey: true, key: 'c' }), true)).toBe(
    'passthrough',
  );
});

test('app chords are swallowed so xterm never forwards them (mac ⌘, else Ctrl)', () => {
  for (const k of ['t', 'w', 'f']) {
    expect(classifyKeyEvent(key({ metaKey: true, key: k }), true)).toBe('swallow');
    expect(classifyKeyEvent(key({ ctrlKey: true, key: k }), false)).toBe('swallow');
  }
  // Zoom is ⌘/Ctrl + Shift + E on both platforms.
  expect(classifyKeyEvent(key({ metaKey: true, shiftKey: true, key: 'e' }), true)).toBe('swallow');
  expect(classifyKeyEvent(key({ ctrlKey: true, shiftKey: true, key: 'E' }), false)).toBe('swallow');
});

test('smart copy: ⌘C on mac / Ctrl+C elsewhere resolve to the copy intent', () => {
  expect(classifyKeyEvent(key({ metaKey: true, key: 'c' }), true)).toBe('copy');
  expect(classifyKeyEvent(key({ ctrlKey: true, key: 'c' }), false)).toBe('copy');
  // On mac, Ctrl+C is NOT the copy key — it stays a passthrough (raw SIGINT).
  expect(classifyKeyEvent(key({ ctrlKey: true, key: 'c' }), true)).toBe('passthrough');
});

test('paste: ⌘V on mac; Ctrl+V and Ctrl+Shift+V elsewhere', () => {
  expect(classifyKeyEvent(key({ metaKey: true, key: 'v' }), true)).toBe('paste');
  expect(classifyKeyEvent(key({ ctrlKey: true, key: 'v' }), false)).toBe('paste');
  expect(classifyKeyEvent(key({ ctrlKey: true, shiftKey: true, key: 'v' }), false)).toBe('paste');
  // ⌘V is not a mac paste-through-to-shell — swallowed as paste, not passthrough.
  expect(classifyKeyEvent(key({ ctrlKey: true, key: 'v' }), true)).toBe('passthrough');
});

test('Shift+Enter is the multiline (ESC+\\n) intent, plain Enter is not', () => {
  expect(classifyKeyEvent(key({ shiftKey: true, key: 'Enter' }), true)).toBe('multiline');
  expect(classifyKeyEvent(key({ key: 'Enter' }), true)).toBe('passthrough');
});

test('⌘/Ctrl + Backspace is the kill-line intent', () => {
  expect(classifyKeyEvent(key({ metaKey: true, key: 'Backspace' }), true)).toBe('killline');
  expect(classifyKeyEvent(key({ ctrlKey: true, key: 'Backspace' }), false)).toBe('killline');
  // A bare Backspace passes through (normal delete).
  expect(classifyKeyEvent(key({ key: 'Backspace' }), true)).toBe('passthrough');
});

test('OSC 133 prompt navigation: ⌘/Ctrl + Arrow Up/Down (#405)', () => {
  expect(classifyKeyEvent(key({ metaKey: true, key: 'ArrowUp' }), true)).toBe('prev-prompt');
  expect(classifyKeyEvent(key({ metaKey: true, key: 'ArrowDown' }), true)).toBe('next-prompt');
  expect(classifyKeyEvent(key({ ctrlKey: true, key: 'ArrowUp' }), false)).toBe('prev-prompt');
  // A BARE arrow must still reach the shell — it is history / readline navigation.
  expect(classifyKeyEvent(key({ key: 'ArrowUp' }), true)).toBe('passthrough');
});

test('copy-last-output is ⌘/Ctrl+Shift+O and does not shadow smart copy (#405)', () => {
  expect(classifyKeyEvent(key({ metaKey: true, shiftKey: true, key: 'o' }), true)).toBe(
    'copy-last-output',
  );
  expect(classifyKeyEvent(key({ ctrlKey: true, shiftKey: true, key: 'O' }), false)).toBe(
    'copy-last-output',
  );
  // ⌘C is still smart copy — the new chord sits beside it, not over it.
  expect(classifyKeyEvent(key({ metaKey: true, key: 'c' }), true)).toBe('copy');
});

test('⌘1..9 is swallowed so the digits never reach the PTY (#405)', () => {
  // The view's shortcut hook performs the tab select; the keymap only has to stop
  // xterm from ALSO typing the digit into the shell.
  for (const digit of ['1', '5', '9']) {
    expect(classifyKeyEvent(key({ metaKey: true, key: digit }), true)).toBe('swallow');
    expect(classifyKeyEvent(key({ ctrlKey: true, key: digit }), false)).toBe('swallow');
  }
  // A bare digit is ordinary typing, and ⌘0 is not a tab chord.
  expect(classifyKeyEvent(key({ key: '3' }), true)).toBe('passthrough');
  expect(classifyKeyEvent(key({ metaKey: true, key: '0' }), true)).toBe('passthrough');
});
