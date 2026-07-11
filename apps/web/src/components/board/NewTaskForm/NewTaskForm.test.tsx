import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { planFirstDefault } from './NewTaskForm.hooks';
import * as stories from './NewTaskForm.stories';

const { Default } = composeStories(stories);

test('planFirstDefault seeds plan-first only for a Build task on a hooks-capable provider', () => {
  // The interactive default-on: Build + gate on + a plan-capable provider.
  expect(planFirstDefault('build', true, true)).toBe(true);
  // Fix 3 (#147): a hookless provider (Codex) is NEVER plan-gated by the default —
  // a plan-mode run there surfaces no plan and would silently no-op.
  expect(planFirstDefault('build', true, false)).toBe(false);
  // Non-Build kinds and a disabled gate default off regardless of the provider.
  expect(planFirstDefault('research', true, true)).toBe(false);
  expect(planFirstDefault('build', false, true)).toBe(false);
});

test('gates create on a non-empty title, then fires onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  const create = screen.getByRole('button', { name: /create task/i });
  await expect.element(create).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Title').element(), 'Add a panel');
  await expect.element(create).toBeEnabled();
  await create.click();

  expect(onCreate).toHaveBeenCalledWith('Add a panel', '', 'build', 'main', {
    permissionMode: null,
    // Build + the default-on plan gate ⇒ the "Plan first" toggle seeds true.
    planFirst: true,
    model: null,
    effort: null,
    maxTurns: null,
    // A blank budget field inherits (no override on the wire).
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});

test('threads an explicit max-turns ceiling through onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText('Title').element(), 'Bounded run');
  await userEvent.type(screen.getByLabelText('Max turns').element(), '40');
  await screen.getByRole('button', { name: /create task/i }).click();

  expect(onCreate).toHaveBeenCalledWith('Bounded run', '', 'build', 'main', {
    permissionMode: null,
    planFirst: true,
    model: null,
    effort: null,
    maxTurns: 40,
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});

test('a $0 max-budget inherits — 0 is not a valid ceiling (#240)', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText('Title').element(), 'Zero budget');
  // The wire contract is `maxBudgetUsd: positive().optional()` — a $0 ceiling is
  // unrunnable, so "0" must inherit exactly like the blank field above (not send 0).
  await userEvent.type(screen.getByLabelText('Max budget (USD)').element(), '0');
  await screen.getByRole('button', { name: /create task/i }).click();

  expect(onCreate).toHaveBeenCalledWith('Zero budget', '', 'build', 'main', {
    permissionMode: null,
    planFirst: true,
    model: null,
    effort: null,
    maxTurns: null,
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});
