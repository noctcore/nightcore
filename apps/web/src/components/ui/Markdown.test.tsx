import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { Markdown, MAX_MARKDOWN_LENGTH, renderMarkdown } from './Markdown';
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

test('external links get target=_blank and rel=noopener noreferrer', () => {
  const html = renderMarkdown('[click me](https://phishing.example)');
  expect(html).toContain('href="https://phishing.example"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
});

test('inline code and emphasis become real elements', () => {
  const html = renderMarkdown('a `code` and **bold**');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<strong>bold</strong>');
});

test('streaming mode renders raw text and skips the markdown parse', () => {
  const screen = render(<Markdown streaming>{'**bold** and a heading'}</Markdown>);
  // The literal markers survive — no `marked` pass ran on the streaming delta.
  expect(screen.container.textContent).toContain('**bold** and a heading');
  expect(screen.container.querySelector('strong')).toBeNull();
});

test('a body over the size cap falls back to raw text', () => {
  const big = `# Heading\n${'x'.repeat(MAX_MARKDOWN_LENGTH)}`;
  const screen = render(<Markdown>{big}</Markdown>);
  // Oversized → rendered as plain text, so no parsed heading element is emitted.
  expect(screen.container.querySelector('h1')).toBeNull();
  expect(screen.container.textContent).toContain('# Heading');
});

test('non-streaming, in-cap bodies still parse to real markdown elements', () => {
  const screen = render(<Markdown>{'**bold**'}</Markdown>);
  expect(screen.container.querySelector('strong')).not.toBeNull();
});
