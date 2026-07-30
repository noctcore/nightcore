import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PolicyStarterPacks.stories';

const { Default, NoProfile, PlainRepo, PartiallyApplied } = composeStories(stories);

test('an empty policy opens the strip and offers the keyed packs', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('Rust workspace', { exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('Tauri detected')).toBeInTheDocument();
});

test('applying a pack hands its entries up, never writing anything itself', async () => {
  const onApply = vi.fn();
  const screen = render(<Default onApply={onApply} />);
  await screen.getByRole('button', { name: /add no web egress/i }).click();
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0]?.[0]).toEqual({
    disallowedTools: ['WebFetch', 'WebSearch'],
  });
});

test('an unscanned project says why the keyed packs are missing', async () => {
  const screen = render(<NoProfile />);
  await expect.element(screen.getByText(/run a harness scan/i)).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Rust workspace');
});

test('a plain repo is not offered stack packs it has no use for', async () => {
  const screen = render(<PlainRepo />);
  await expect
    .element(screen.getByText('Secret hygiene', { exact: true }))
    .toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Monorepo boundaries');
});

test('a fully applied pack reads as added instead of inviting a no-op click', async () => {
  const screen = render(<PartiallyApplied />);
  await expect.element(screen.getByText('Added')).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Add no web egress');
});

test('the strip collapses and re-expands from the keyboard', async () => {
  const screen = render(<Default />);
  const toggle = screen.getByRole('button', { name: /^hide$/i });
  await toggle.click();
  await expect
    .element(screen.getByRole('button', { name: /show \d+ available/i }))
    .toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('Secret hygiene');
});
