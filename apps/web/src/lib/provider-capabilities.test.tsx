import { expect, test } from 'vitest';

import {
  capabilitiesForProvider,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
} from './provider-capabilities';

test('capabilitiesForProvider resolves the selected task provider', () => {
  expect(capabilitiesForProvider('codex', CLAUDE_CAPABILITIES)).toBe(CODEX_CAPABILITIES);
  expect(capabilitiesForProvider('claude', null)).toBe(CLAUDE_CAPABILITIES);
  expect(capabilitiesForProvider(undefined, CLAUDE_CAPABILITIES)).toBe(CLAUDE_CAPABILITIES);
});
