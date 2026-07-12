import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { buildPolicyPatch, cleanList, draftFromPolicy, limitError } from './PolicyEditor.hooks';
import * as stories from './PolicyEditor.stories';

const { Default, NoManifest, Loading } = composeStories(stories);

// --- pure draft/patch logic --------------------------------------------------

test('cleanList trims rows and drops empties and duplicates', () => {
  expect(cleanList([' bun.lock ', '', 'bun.lock', '  ', 'migrations/**'])).toEqual([
    'bun.lock',
    'migrations/**',
  ]);
});

test('limitError accepts empty (unset) and whole numbers, rejects the rest', () => {
  expect(limitError('')).toBeNull();
  expect(limitError('  ')).toBeNull();
  expect(limitError('400')).toBeNull();
  expect(limitError('0')).not.toBeNull();
  expect(limitError('-5')).not.toBeNull();
  expect(limitError('4.5')).not.toBeNull();
  expect(limitError('lots')).not.toBeNull();
});

test('buildPolicyPatch maps cleared limit inputs to null (unset)', () => {
  const draft = {
    enabled: false,
    protectedPaths: ['bun.lock', 'bun.lock'],
    denyBashPatterns: [],
    denyReadPaths: [' .env* '],
    disallowedTools: [''],
    askTools: ['WebFetch', 'WebFetch'],
    allowTools: [],
    maxChangedLines: '',
    maxChangedFiles: '20',
  };
  expect(buildPolicyPatch(draft)).toEqual({
    enabled: false,
    protectedPaths: ['bun.lock'],
    denyBashPatterns: [],
    denyReadPaths: ['.env*'],
    disallowedTools: [],
    askTools: ['WebFetch'],
    allowTools: [],
    diffBudget: { maxChangedLines: null, maxChangedFiles: 20 },
  });
});

test('draftFromPolicy stringifies the diff budget for the clearable inputs', () => {
  const draft = draftFromPolicy({
    enabled: true,
    protectedPaths: [],
    denyBashPatterns: [],
    denyReadPaths: [],
    disallowedTools: [],
    askTools: [],
    allowTools: [],
    allowExecSinks: [],
    diffBudget: { maxChangedLines: 400, maxChangedFiles: null },
    manifestExists: true,
  });
  expect(draft.maxChangedLines).toBe('400');
  expect(draft.maxChangedFiles).toBe('');
});

// --- rendered behavior --------------------------------------------------------

test('renders the loaded policy values and no dirty indicator', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByRole('textbox', { name: 'Protected paths entry 1' }))
    .toHaveValue('bun.lock');
  await expect.element(screen.getByLabelText('Max changed lines')).toHaveValue('400');
  await expect
    .element(screen.getByRole('button', { name: /save policy/i }))
    .toBeDisabled();
  expect(screen.container.textContent).not.toContain('Unsaved changes');
});

test('editing a row marks the editor dirty and saving fires the assembled patch', async () => {
  const onSave = vi.fn();
  const screen = render(<Default onSave={onSave} />);
  const input = screen.getByRole('textbox', { name: 'Denied read paths entry 1' });
  await input.fill('secrets/**');
  await expect.element(screen.getByText('Unsaved changes')).toBeInTheDocument();
  await screen.getByRole('button', { name: /save policy/i }).click();
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    denyReadPaths: ['secrets/**'],
    protectedPaths: ['bun.lock', 'migrations/**'],
    diffBudget: { maxChangedLines: 400, maxChangedFiles: null },
  });
});

test('an invalid diff-budget limit blocks save with an inline error', async () => {
  const screen = render(<Default />);
  await screen.getByLabelText('Max changed lines').fill('lots');
  await expect
    .element(screen.getByText('Enter a whole number of 1 or more.'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /save policy/i }))
    .toBeDisabled();
});

test('clearing a limit is a valid unset and saves diffBudget null', async () => {
  const onSave = vi.fn();
  const screen = render(<Default onSave={onSave} />);
  await screen.getByLabelText('Max changed lines').fill('');
  await screen.getByRole('button', { name: /save policy/i }).click();
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    diffBudget: { maxChangedLines: null, maxChangedFiles: null },
  });
});

test('a missing manifest surfaces the create-on-save affordance', async () => {
  const screen = render(<NoManifest />);
  await expect
    .element(screen.getByText(/saving creates/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /create manifest/i }))
    .toBeInTheDocument();
});

test('shows a skeleton while the policy loads', async () => {
  const screen = render(<Loading />);
  const status = screen.container.querySelector('[role="status"][aria-busy="true"]');
  expect(status).not.toBeNull();
});
