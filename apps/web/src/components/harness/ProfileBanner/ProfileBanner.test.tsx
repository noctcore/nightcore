import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProfileBanner.stories';

const { Ready, Loading } = composeStories(stories);

test('renders the monorepo badge, workspace tool, and capability flags', async () => {
  const screen = render(<Ready />);
  await expect.element(screen.getByText('Monorepo')).toBeInTheDocument();
  await expect.element(screen.getByText('bun')).toBeInTheDocument();
  await expect.element(screen.getByText('react')).toBeInTheDocument();
  await expect.element(screen.getByText('lint-meta')).toBeInTheDocument();
});

test('shows a skeleton status region while the profile is loading', async () => {
  const screen = render(<Loading />);
  const status = screen.container.querySelector('[role="status"][aria-busy="true"]');
  expect(status).not.toBeNull();
});

test('conveys each capability state textually, not by color alone', async () => {
  const screen = render(<Ready />);
  // PROFILE has lint-meta present and agent docs absent; the labels must
  // distinguish them so a screen reader isn't relying on the chip color.
  expect(screen.container.querySelector('[aria-label="lint-meta: present"]')).not.toBeNull();
  expect(screen.container.querySelector('[aria-label="agent docs: absent"]')).not.toBeNull();
});
