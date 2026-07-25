import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { CodeBlock } from './CodeBlock';
import { isHighlightable, MAX_HIGHLIGHT_LENGTH, resolveLang } from './CodeBlock.hooks';
import * as stories from './CodeBlock.stories';

const { TypeScript, UnknownLanguage } = composeStories(stories);

test('renders the code text synchronously (raw <pre> fallback, no blank flash)', async () => {
  const screen = render(<TypeScript />);
  // Present immediately — before the async highlighter resolves.
  await expect.element(screen.getByText(/Hello/)).toBeInTheDocument();
  expect(screen.container.querySelector('pre')).not.toBeNull();
});

test('upgrades to Shiki-highlighted output once the highlighter resolves', async () => {
  const screen = render(<TypeScript />);
  await vi.waitFor(
    () => expect(screen.container.querySelector('pre.shiki')).not.toBeNull(),
    { timeout: 10000 },
  );
  // Text survives the swap from fallback to highlighted.
  expect(screen.container.textContent).toContain('Hello');
});

test('renders unknown languages as plain text without throwing', async () => {
  const screen = render(<UnknownLanguage />);
  await expect.element(screen.getByText(/plain text, no grammar/)).toBeInTheDocument();
});

test('shows a copy button by default that flips to a copied state on click', async () => {
  const screen = render(<TypeScript />);
  const button = screen.getByRole('button', { name: 'Copy code' });
  await expect.element(button).toBeInTheDocument();
  await button.click();
  // The label swaps to the copied affordance (the clipboard write is best-effort).
  await expect.element(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
});

test('copyable={false} renders no copy button', async () => {
  const screen = render(<CodeBlock code="const x = 1;" language="ts" copyable={false} />);
  expect(screen.container.querySelector('button')).toBeNull();
});

test('isHighlightable caps at MAX_HIGHLIGHT_LENGTH so huge payloads stay plain <pre>', () => {
  expect(isHighlightable('const x = 1;')).toBe(true);
  expect(isHighlightable('x'.repeat(MAX_HIGHLIGHT_LENGTH))).toBe(true);
  expect(isHighlightable('x'.repeat(MAX_HIGHLIGHT_LENGTH + 1))).toBe(false);
});

test('resolveLang maps aliases/extensions to grammars and unknowns to text', () => {
  expect(resolveLang('ts')).toBe('typescript');
  expect(resolveLang('.tsx')).toBe('tsx');
  expect(resolveLang('JS')).toBe('javascript');
  expect(resolveLang('md')).toBe('markdown');
  expect(resolveLang('sh')).toBe('bash');
  expect(resolveLang('diff')).toBe('diff');
  expect(resolveLang('patch')).toBe('diff');
  expect(resolveLang(undefined)).toBe('text');
  expect(resolveLang('cobol')).toBe('text');
});
