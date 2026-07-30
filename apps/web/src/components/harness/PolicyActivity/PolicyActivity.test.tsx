import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PolicyActivity.stories';

const { Default, Empty, Loading } = composeStories(stories);

test('a blocked call names the rule, the tool and the target', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('Write to a protected path', { exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('bun.lock', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('harness-protected-path', { exact: true }))
    .toBeInTheDocument();
});

test('an escalation reads as asked, not blocked', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Asked', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('Ask-first tool', { exact: true }))
    .toBeInTheDocument();
});

test("the author's own rules are kept apart from the built-in rails", async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('built-in rail', { exact: true }).first())
    .toBeInTheDocument();
  // Three of the five mock rows come from the project's policy.
  await expect.element(screen.getByText('3 from your policy')).toBeInTheDocument();
});

test('an unrecognized rail is still shown and still attributed', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText('some-future-rail', { exact: true }).first())
    .toBeInTheDocument();
});

test('an empty feed says nothing hit the rails, not that nothing loaded', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByText(/no blocked calls recorded/i)).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain('from your policy');
});

test('a pending read shows a skeleton rather than an empty state', async () => {
  const screen = render(<Loading />);
  const status = screen.container.querySelector('[role="status"][aria-busy="true"]');
  expect(status).not.toBeNull();
  expect(screen.container.textContent).not.toContain('No blocked calls recorded');
});

test('refresh is reachable and fires exactly one read', async () => {
  const onRefresh = vi.fn();
  const screen = render(<Default onRefresh={onRefresh} />);
  const button = screen.getByRole('button', { name: /refresh/i });
  await button.click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('refresh is disabled while a read is in flight', async () => {
  const screen = render(<Loading />);
  await expect
    .element(screen.getByRole('button', { name: /refresh/i }))
    .toBeDisabled();
});
