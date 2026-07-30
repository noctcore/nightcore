import { expect, test } from 'vitest';

import { CONFIRM_CHORD, DEFAULT_TERMINAL_WEBGL, IS_MAC, resolveTerminalWebgl } from './platform';

test('the confirm chord matches the detected platform', () => {
  expect(CONFIRM_CHORD).toBe(IS_MAC ? '⌘↵' : 'Ctrl↵');
});

test('the terminal renderer default is GPU everywhere but macOS', () => {
  // #407 scoped "WebGL default-on" by the evidence: xtermjs#5816 (WebGL corruption
  // reported from a Tauri app) is still open on macOS, and xterm 6 has no canvas
  // renderer left to fall back to — so WebKit stays on DOM by default.
  expect(DEFAULT_TERMINAL_WEBGL).toBe(!IS_MAC);
});

test('an explicit stored choice always beats the platform default', () => {
  expect(resolveTerminalWebgl(true)).toBe(true);
  expect(resolveTerminalWebgl(false)).toBe(false);
});

test('an unset choice resolves to the platform default', () => {
  // Both absent forms — `null` on the wire, `undefined` before settings load.
  expect(resolveTerminalWebgl(null)).toBe(DEFAULT_TERMINAL_WEBGL);
  expect(resolveTerminalWebgl(undefined)).toBe(DEFAULT_TERMINAL_WEBGL);
});
