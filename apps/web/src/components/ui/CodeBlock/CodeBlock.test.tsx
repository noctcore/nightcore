import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { resolveLang } from './CodeBlock.hooks';
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

test('resolveLang maps aliases/extensions to grammars and unknowns to text', () => {
  expect(resolveLang('ts')).toBe('typescript');
  expect(resolveLang('.tsx')).toBe('tsx');
  expect(resolveLang('JS')).toBe('javascript');
  expect(resolveLang('md')).toBe('markdown');
  expect(resolveLang('sh')).toBe('bash');
  expect(resolveLang(undefined)).toBe('text');
  expect(resolveLang('cobol')).toBe('text');
});
