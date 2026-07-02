import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './InjectionScanCard.stories';

const { Default, AlreadyQuarantined, CleanRepo } = composeStories(stories);

test('running the scan lists every flagged path with its reasons', async () => {
  const screen = render(<Default />);
  await screen.getByRole('button', { name: /run scan/i }).click();
  await expect.element(screen.getByText('docs/pasted-snippet.md')).toBeInTheDocument();
  await expect.element(screen.getByText('vendor/readme.txt')).toBeInTheDocument();
  await expect
    .element(screen.getByText(/instruction-shaped phrase/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/trojan-source|zero-width/i))
    .toBeInTheDocument();
});

test('quarantining a row calls onQuarantine with the flagged path', async () => {
  const onQuarantine = vi.fn();
  const screen = render(<Default onQuarantine={onQuarantine} />);
  await screen.getByRole('button', { name: /run scan/i }).click();
  await screen.getByRole('button', { name: /^quarantine$/i }).first().click();
  expect(onQuarantine).toHaveBeenCalledWith('docs/pasted-snippet.md');
});

test('a path already in denyReadPaths renders a disabled Quarantined action', async () => {
  const screen = render(<AlreadyQuarantined />);
  await screen.getByRole('button', { name: /run scan/i }).click();
  await expect
    .element(screen.getByRole('button', { name: /^quarantined$/i }))
    .toBeDisabled();
  // The other flagged row is still actionable.
  await expect
    .element(screen.getByRole('button', { name: /^quarantine$/i }))
    .toBeEnabled();
});

test('a clean scan reports the honest zero-flag state', async () => {
  const screen = render(<CleanRepo />);
  await screen.getByRole('button', { name: /run scan/i }).click();
  await expect
    .element(screen.getByText(/no flagged files/i))
    .toBeInTheDocument();
});

test('before any scan, an explainer shows instead of results', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/sweeps every git-tracked text file/i))
    .toBeInTheDocument();
});
