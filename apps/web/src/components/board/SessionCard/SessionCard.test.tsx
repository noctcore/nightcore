import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { makeTask } from '../_fixtures';
import { summarizeSession } from './SessionCard.hooks';
import * as stories from './SessionCard.stories';

const { Editable, Readonly } = composeStories(stories);

test('an editable task opens the card and surfaces the per-task pickers', async () => {
  const screen = render(<Editable />);
  // Opened by default for an editable task — the permission picker is present.
  await expect
    .element(screen.getByRole('radiogroup', { name: /permission mode/i }))
    .toBeInTheDocument();
});

test('a read-only task collapses to its middot summary and expands to pills', async () => {
  const onChangeKind = vi.fn();
  const screen = render(<Readonly actions={{ ...Readonly.args!.actions!, onChangeKind }} />);
  // Collapsed by default for a read-only task; its summary line names the run mode.
  const summary = screen.getByRole('button', { name: /worktree/i });
  await expect.element(summary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  // Once open, the toggle label flips to "Session" — re-query by its stable
  // `aria-controls` anchor rather than the now-changed accessible name.
  const toggle = screen.container.querySelector('button[aria-controls="session-card-body"]');
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  // Read-only body shows static pills, never the editable kind picker.
  expect(screen.container.querySelector('[role="radiogroup"]')).toBeNull();
});

test('summarizeSession joins the config into a single middot line', () => {
  const line = summarizeSession(
    makeTask({
      kind: 'build',
      runMode: 'worktree',
      permissionMode: 'bypass',
      model: 'claude-opus-4-8',
      effort: 'high',
      maxTurns: 40,
      maxBudgetUsd: 5,
    }),
  );
  expect(line).toContain('·');
  expect(line).toContain('40 turns');
  expect(line).toContain('$5');
});
