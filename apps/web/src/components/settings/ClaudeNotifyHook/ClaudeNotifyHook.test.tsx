import { expect, test } from 'vitest';

import { claudeNotifyHookSnippet } from './ClaudeNotifyHook.hooks';

test('the snippet is valid JSON with a Stop hook that emits an OSC 777 to the tty', () => {
  const snippet = claudeNotifyHookSnippet();
  const parsed = JSON.parse(snippet) as {
    hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> };
  };
  const command = parsed.hooks.Stop[0]?.hooks[0]?.command ?? '';
  expect(parsed.hooks.Stop[0]?.hooks[0]?.type).toBe('command');
  // OSC 777 desktop-notification escape, written to the controlling terminal.
  expect(command).toContain('777;notify');
  expect(command).toContain('> /dev/tty');
  // The ESC / BEL bytes printf expands (backslash-escaped in the JSON source).
  expect(command).toContain('\\033');
  expect(command).toContain('\\007');
});
