/** Unit tests for the provider-neutral stored-transcript text accessor. */
import { expect, test } from 'vitest';

import { extractMessageText } from '@/lib/transcript';

test('extractMessageText joins text blocks and tolerates a string content', () => {
  expect(extractMessageText({ role: 'user', content: 'hi there' })).toBe('hi there');
  expect(
    extractMessageText({
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        { type: 'tool_use', id: 't', name: 'Bash', input: {} },
        { type: 'text', text: 'two' },
      ],
    }),
  ).toBe('one\n\ntwo');
  // A pure tool-use turn has no text.
  expect(extractMessageText({ role: 'assistant', content: [{ type: 'tool_use' }] })).toBe('');
});

test('extractMessageText returns empty for a missing/malformed content field', () => {
  expect(extractMessageText({ role: 'user' })).toBe('');
  expect(extractMessageText({ role: 'user', content: 42 })).toBe('');
  // Non-text / malformed blocks are skipped, text blocks still join.
  expect(
    extractMessageText({
      content: [null, { type: 'text' }, { type: 'text', text: 5 }, { type: 'text', text: 'ok' }],
    }),
  ).toBe('ok');
});
