import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './SettingsView.stories';

const { Global, NoActiveProject } = composeStories(stories);

test('updates a global setting with the SDK long id when scope is Global', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  const model = screen.getByRole('combobox', { name: 'Default model' });
  await expect.element(model).toBeInTheDocument();
  (model.element() as HTMLElement).focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  // The persisted value is the SDK long id, not the short label.
  expect(onUpdate).toHaveBeenCalledWith({ defaultModel: 'claude-sonnet-4-6' });
});

test('commits a Max-turns ceiling as a global guardrail patch', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  const input = screen.getByRole('spinbutton', { name: 'Max turns' });
  await input.fill('120');
  // Commit on blur (Enter or focus-out).
  await screen.getByRole('spinbutton', { name: 'Max budget in USD' }).click();
  expect(onUpdate).toHaveBeenCalledWith({ maxTurns: 120 });
});

test('routes a Max-budget ceiling to a project override under the project scope', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('radio', { name: 'nightcore' }).click();
  const input = screen.getByRole('spinbutton', { name: 'Max budget in USD' });
  await input.fill('2.5');
  await screen.getByRole('spinbutton', { name: 'Max turns' }).click();
  expect(onUpdate).toHaveBeenCalledWith({ maxBudgetUsd: 2.5, projectId: 'nightcore' });
});

test('routes the patch to a project override under the project scope', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  // Switch to the per-project scope (the radio labelled with the project name).
  await screen.getByRole('radio', { name: 'nightcore' }).click();
  await screen.getByRole('combobox', { name: 'Default model' }).click();
  await screen.getByRole('option', { name: /Opus/ }).click();
  expect(onUpdate).toHaveBeenCalledWith({
    defaultModel: 'claude-opus-4-8',
    projectId: 'nightcore',
  });
});

test('makes the worktree cleanup toggle editable and global-only', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: /git worktrees/i }).click();
  await screen.getByRole('switch', { name: /delete worktree on merge/i }).click();
  // cleanupWorktrees is global by design — no projectId even from a default story
  // that has an active project.
  expect(onUpdate).toHaveBeenCalledWith({ cleanupWorktrees: false });
});

test('surfaces the default run mode selector and routes it scoped', async () => {
  const onUpdate = vi.fn();
  const screen = render(<Global onUpdate={onUpdate} />);
  await screen.getByRole('button', { name: /git worktrees/i }).click();
  await screen.getByRole('radio', { name: 'Worktree', exact: true }).click();
  expect(onUpdate).toHaveBeenCalledWith({ defaultRunMode: 'worktree' });
});

test('shows a static Global indicator (no scope toggle) when no project is active', async () => {
  const screen = render(<NoActiveProject />);
  // There is no per-project override to choose, so the header states the settings
  // are global rather than offering a toggle that would silently do nothing.
  await expect.element(screen.getByText('Global')).toBeVisible();
  expect(
    screen.container.querySelector('[role="radiogroup"][aria-label="Settings scope"]'),
  ).toBeNull();
});

test('offers a scope choice only on pages that really have one', async () => {
  const screen = render(<Global />);
  const scopeToggle = '[role="radiogroup"][aria-label="Settings scope"]';

  // Models writes `defaultModel` etc., all fields of the Rust override shape.
  expect(screen.container.querySelector(scopeToggle)).not.toBeNull();

  // Notifications writes only global fields, so there is nothing to scope — derived
  // from the shape, not from a hand-kept page list (issue #404).
  await screen.getByRole('button', { name: /notifications/i }).click();
  expect(screen.container.querySelector(scopeToggle)).toBeNull();

  // Permissions writes `permissionMode` (overridable) beside global-only governance
  // toggles, so the choice comes back.
  await screen.getByRole('button', { name: /permissions/i }).click();
  expect(screen.container.querySelector(scopeToggle)).not.toBeNull();
});

test('a scope badge jumps to where the setting actually applies', async () => {
  const screen = render(<Global />);
  await screen.getByRole('button', { name: /permissions/i }).click();
  // `permissionMode` is overridable, so its badge IS the deep-link: it switches the
  // tab to the project whose value it would edit.
  await screen
    .getByRole('button', { name: 'Global default — set this for nightcore only' })
    .click();
  await expect
    .element(screen.getByRole('radio', { name: 'nightcore' }))
    .toHaveAttribute('aria-checked', 'true');

  // …and once there, the badge names the project and links back to the global default.
  await expect
    .element(
      screen.getByRole('button', {
        name: 'Applies to nightcore only — edit the global default instead',
      }),
    )
    .toBeInTheDocument();
  // The global-only governance toggles on the same page still admit they are global.
  await expect.element(screen.getByText('Global', { exact: true }).first()).toBeVisible();
});

test('points at the relocated YOLO toggle from both of its old homes', async () => {
  const screen = render(<Global />);
  for (const page of [/^interface$/i, /^terminal$/i]) {
    await screen.getByRole('button', { name: page }).click();
    await expect
      .element(screen.getByText('Skip Claude permissions (YOLO)'))
      .toBeInTheDocument();
    await screen.getByRole('button', { name: 'Open Permissions' }).click();
    // The signpost lands on the page that owns the toggle now.
    await expect
      .element(screen.getByRole('switch', { name: /skip claude permissions/i }))
      .toBeInTheDocument();
  }
});

test('navigates between settings pages via the left nav', async () => {
  const screen = render(<Global />);
  await screen.getByRole('button', { name: /permissions/i }).click();
  await expect.element(screen.getByText('Tool permissions')).toBeInTheDocument();
});

test('runs onboarding from the About page', async () => {
  const onRestartOnboarding = vi.fn();
  const screen = render(<Global onRestartOnboarding={onRestartOnboarding} />);
  await screen.getByRole('button', { name: /about/i }).click();
  await screen.getByRole('button', { name: /run onboarding/i }).click();
  expect(onRestartOnboarding).toHaveBeenCalled();
});
