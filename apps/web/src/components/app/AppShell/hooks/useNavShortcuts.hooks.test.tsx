import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { NavItem } from '../AppShell.types';
import { useNavShortcuts } from './useNavShortcuts.hooks';

const NAV: NavItem[] = [
  { view: 'board', label: 'Kanban Board', hint: 'K', icon: null },
  { view: 'settings', label: 'Settings', hint: 'S', icon: null },
];

function Harness({
  goto,
  enabled = true,
}: {
  goto: (view: string) => void;
  enabled?: boolean;
}) {
  useNavShortcuts(NAV, goto as (view: NavItem['view']) => void, enabled);
  return null;
}

function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

test('a bare nav-hint key routes to its view', () => {
  const goto = vi.fn();
  render(<Harness goto={goto} />);
  press('s');
  expect(goto).toHaveBeenCalledWith('settings');
  press('k');
  expect(goto).toHaveBeenCalledWith('board');
});

test('matches case-insensitively (Shift/CapsLock still navigates)', () => {
  const goto = vi.fn();
  render(<Harness goto={goto} />);
  press('S', { shiftKey: true });
  expect(goto).toHaveBeenCalledWith('settings');
});

test('ignores keys held with a command/ctrl/alt modifier', () => {
  const goto = vi.fn();
  render(<Harness goto={goto} />);
  press('s', { metaKey: true });
  press('s', { ctrlKey: true });
  press('s', { altKey: true });
  expect(goto).not.toHaveBeenCalled();
});

test('ignores keystrokes while focus is in a text input', () => {
  const goto = vi.fn();
  render(<Harness goto={goto} />);
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
  expect(goto).not.toHaveBeenCalled();
  input.remove();
});

test('does nothing for keys that are not nav hints', () => {
  const goto = vi.fn();
  render(<Harness goto={goto} />);
  press('z');
  expect(goto).not.toHaveBeenCalled();
});

test('detaches the listener when disabled', () => {
  const goto = vi.fn();
  render(<Harness goto={goto} enabled={false} />);
  press('s');
  expect(goto).not.toHaveBeenCalled();
});
