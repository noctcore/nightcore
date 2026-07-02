import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { renderMarkdown } from './Markdown';
import * as stories from './Markdown.stories';

const { Rich, SanitizesScripts } = composeStories(stories);

test('renders markdown structure (heading, list, code, link)', async () => {
  const screen = render(<Rich />);
  await expect.element(screen.getByRole('heading', { name: /verdict/i })).toBeInTheDocument();
  await expect.element(screen.getByRole('link', { name: /the contract/i })).toBeInTheDocument();
});

test('strips scripts and event handlers from the rendered HTML', () => {
  const dirty = renderMarkdown('ok <script>alert(1)</script> <img src=x onerror=alert(1)>');
  expect(dirty).not.toContain('<script');
  expect(dirty).not.toContain('onerror');
  expect(dirty).toContain('ok');
});

test('renders the sanitized-scripts story without a live script node', async () => {
  const screen = render(<SanitizesScripts />);
  await expect.element(screen.getByText(/Hello/)).toBeInTheDocument();
  expect(screen.container.querySelector('script')).toBeNull();
});

test('inline code and emphasis become real elements', () => {
  const html = renderMarkdown('a `code` and **bold**');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<strong>bold</strong>');
});
