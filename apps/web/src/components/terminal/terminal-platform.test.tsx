import { afterEach, expect, test } from 'vitest';

import { formatShortcut, isMacPlatform, setTerminalPlatform } from './terminal-platform';

// The platform is module-level; restore a stable default after each test so a forced
// value here can't leak into other suites sharing the module instance.
afterEach(() => {
  setTerminalPlatform('macos');
});

test('setTerminalPlatform refines the primary modifier from the host OS', () => {
  setTerminalPlatform('macos');
  expect(isMacPlatform()).toBe(true);
  setTerminalPlatform('linux');
  expect(isMacPlatform()).toBe(false);
  setTerminalPlatform('windows');
  expect(isMacPlatform()).toBe(false);
});

test('a null / unknown os leaves the current platform untouched', () => {
  setTerminalPlatform('macos');
  setTerminalPlatform(null);
  expect(isMacPlatform()).toBe(true);
  setTerminalPlatform(undefined);
  expect(isMacPlatform()).toBe(true);
});

test('formatShortcut renders ⌘ chords on mac, Ctrl chords elsewhere', () => {
  setTerminalPlatform('macos');
  expect(formatShortcut('t')).toBe('⌘T');
  expect(formatShortcut('w')).toBe('⌘W');
  expect(formatShortcut('e', { shift: true })).toBe('⌘⇧E');

  setTerminalPlatform('linux');
  expect(formatShortcut('t')).toBe('Ctrl+T');
  expect(formatShortcut('w')).toBe('Ctrl+W');
  expect(formatShortcut('e', { shift: true })).toBe('Ctrl+Shift+E');
});
