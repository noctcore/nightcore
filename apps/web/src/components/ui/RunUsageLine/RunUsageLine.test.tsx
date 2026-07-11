import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunUsageLine.stories';

const { Default, DefaultModel, NoUsage } = composeStories(stories);

test('renders model, approximate cost, tokens, and duration', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText(/claude-opus-4-8/)).toBeInTheDocument();
  await expect.element(screen.getByText(/≈ \$0\.42/)).toBeInTheDocument();
  await expect.element(screen.getByText(/147k tok/)).toBeInTheDocument();
  await expect.element(screen.getByText(/1m 14s/)).toBeInTheDocument();
});

test('falls back to "default" when no model is recorded', async () => {
  const screen = render(<DefaultModel />);
  await expect.element(screen.getByText(/default/)).toBeInTheDocument();
});

test('renders a $0 / zero-token run without the token or duration segments', async () => {
  const screen = render(<NoUsage />);
  await expect.element(screen.getByText(/≈ \$0\.00/)).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('tok');
});
