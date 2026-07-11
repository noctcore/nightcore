import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './TerminalTabs.stories';

const {
  Populated,
  Empty,
  WithConfinedTab,
  WithRestoredTabs,
  CapReached,
  WithCustomTitle,
  WithActivityBadges,
} = composeStories(stories);

test('renders one tab per session with the active one selected', async () => {
  const screen = render(<Populated />);
  await expect.element(screen.getByRole('tab', { name: /task-42/ })).toBeInTheDocument();
  await expect.element(screen.getByRole('tab', { name: /task-91/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('selecting a tab fires onSelect', async () => {
  const onSelect = vi.fn();
  const screen = render(<Populated onSelect={onSelect} />);
  await screen.getByRole('tab', { name: /task-12/ }).click();
  expect(onSelect).toHaveBeenCalledWith('task-12');
});

test('the close affordance fires onClose with the session id', async () => {
  const onClose = vi.fn();
  const screen = render(<Populated onClose={onClose} />);
  await screen.getByRole('button', { name: /Close task-91/ }).click();
  expect(onClose).toHaveBeenCalledWith('task-91');
});

test('the new-tab button opens the picker', async () => {
  const onNewTab = vi.fn();
  const screen = render(<Empty onNewTab={onNewTab} />);
  await screen.getByRole('button', { name: /New terminal/ }).click();
  expect(onNewTab).toHaveBeenCalled();
});

test('the empty state still offers the new-tab button', async () => {
  const screen = render(<Empty />);
  await expect.element(screen.getByRole('button', { name: /New terminal/ })).toBeInTheDocument();
});

test('a confined session renders its distinct identity marker', async () => {
  const screen = render(<WithConfinedTab />);
  // The confined tab's title carries the containment copy.
  await expect
    .element(screen.getByRole('tab', { name: /task-91/ }))
    .toHaveAttribute(
      'title',
      'This shell runs inside the opt-in write-containment profile, scoped to its worktree.',
    );
});

test('the new-tab button is disabled at the session cap', async () => {
  const screen = render(<CapReached />);
  await expect
    .element(screen.getByRole('button', { name: /Terminal limit reached \(12\)/ }))
    .toBeDisabled();
});

test('a renamed tab shows its custom title instead of the cwd leaf', async () => {
  const screen = render(<WithCustomTitle />);
  await expect
    .element(screen.getByRole('tab', { name: /deploy shell/ }))
    .toBeInTheDocument();
});

test('double-click opens the inline rename and Enter commits via onRename', async () => {
  const onRename = vi.fn();
  const screen = render(<Populated onRename={onRename} />);
  await userEvent.dblClick(screen.getByRole('tab', { name: /task-91/ }).element());
  const input = screen.getByRole('textbox', { name: /Rename/ });
  await input.fill('deploy shell');
  await userEvent.keyboard('{Enter}');
  expect(onRename).toHaveBeenCalledWith('task-91', 'deploy shell');
});

test('an inactive tab shows its unread-output badge; the active tab does not', async () => {
  const screen = render(<WithActivityBadges />);
  // task-42 (inactive) has 3 unread → its badge is present.
  await expect
    .element(screen.getByLabelText('3 unread output batches'))
    .toBeInTheDocument();
  // The clamped count renders as 99+.
  await expect
    .element(screen.getByLabelText('128 unread output batches'))
    .toHaveTextContent('99+');
});

test('restored tabs render after live ones and dismiss fires onDismiss', async () => {
  const onDismiss = vi.fn();
  const screen = render(<WithRestoredTabs onDismiss={onDismiss} />);
  // The restored tab is a selectable tab (read-only session from a prior run).
  await expect.element(screen.getByRole('tab', { name: /task-77/ })).toBeInTheDocument();
  await screen.getByRole('button', { name: /Dismiss task-77/ }).click();
  expect(onDismiss).toHaveBeenCalledWith('task-77');
});
