import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { appendQuarantinePath } from './PolicySection.hooks';
import * as stories from './PolicySection.stories';

const { Default } = composeStories(stories);

// --- quarantine dedupe logic --------------------------------------------------

test('appendQuarantinePath appends a new path', () => {
  expect(appendQuarantinePath(['.env*'], 'docs/evil.md')).toEqual([
    '.env*',
    'docs/evil.md',
  ]);
});

test('appendQuarantinePath returns null for an already-quarantined path', () => {
  expect(appendQuarantinePath(['.env*', 'docs/evil.md'], 'docs/evil.md')).toBeNull();
});

test('appendQuarantinePath appends to an empty list', () => {
  expect(appendQuarantinePath([], 'a.md')).toEqual(['a.md']);
});

// --- rendered composition -----------------------------------------------------

test('renders the policy editor seeded from the loaded policy and the scan card', async () => {
  const screen = render(<Default />);
  // Editor card, populated from the bridge's mock policy once the load lands.
  await expect
    .element(screen.getByRole('textbox', { name: 'Protected paths entry 1' }))
    .toHaveValue('bun.lock');
  // Scan card, pre-scan state.
  await expect
    .element(screen.getByRole('button', { name: /run scan/i }))
    .toBeInTheDocument();
});

test('renders the activity feed from the bridge mock alongside the editor', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('Write to a protected path', { exact: true }))
    .toBeInTheDocument();
  // Attribution keeps the project's own rules apart from the built-in rails.
  await expect
    .element(screen.getByText('built-in rail', { exact: true }))
    .toBeInTheDocument();
});
