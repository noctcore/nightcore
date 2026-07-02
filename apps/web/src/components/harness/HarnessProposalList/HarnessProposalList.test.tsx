import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './HarnessProposalList.stories';

const { WithArtifacts, Empty } = composeStories(stories);

test('groups artifacts under their group heading', async () => {
  const screen = render(<WithArtifacts />);
  await expect
    .element(screen.getByText('ESLint plugin (@acme/eslint-plugin)'))
    .toBeInTheDocument();
  // The artifact title renders as the card heading (the path + content preview
  // also contain the slug, so target the heading role to disambiguate).
  await expect
    .element(screen.getByRole('heading', { name: 'component-folder-structure' }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Agent guardrails' }))
    .toBeInTheDocument();
});

test('opens an artifact when its card is clicked', async () => {
  const onOpen = vi.fn();
  const screen = render(<WithArtifacts onOpen={onOpen} />);
  await screen.getByRole('heading', { name: 'component-folder-structure' }).click();
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen.mock.calls[0]?.[0]?.id).toBe('a1');
});

test('shows the empty message when there is nothing to render', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText(/run a scan to synthesize a proposed harness/i))
    .toBeInTheDocument();
});
