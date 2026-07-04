import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Sidebar.stories';

const { Default, SwitcherOpen, Running, AwaitingInput } = composeStories(stories);

test('navigates when a nav item is clicked', async () => {
  const onNavigate = vi.fn();
  const screen = render(<Default onNavigate={onNavigate} />);
  await screen.getByText('Kanban Board').click();
  expect(onNavigate).toHaveBeenCalledWith('board');
});

test('the brand/logo returns to the full-screen Projects view', async () => {
  const onGotoProjects = vi.fn();
  const screen = render(<Default onGotoProjects={onGotoProjects} />);
  await screen.getByRole('button', { name: /back to projects/i }).click();
  expect(onGotoProjects).toHaveBeenCalled();
});

test('lists projects and opens new project from the switcher', async () => {
  const onPickProject = vi.fn();
  const onNewProject = vi.fn();
  const screen = render(
    <SwitcherOpen onPickProject={onPickProject} onNewProject={onNewProject} />,
  );
  await screen.getByText('automaker (legacy)').click();
  expect(onPickProject).toHaveBeenCalledWith('automaker');
  await screen.getByRole('button', { name: /new project/i }).click();
  expect(onNewProject).toHaveBeenCalled();
});

test('shows the running-agents indicator when agents are running', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('2 running')).toBeInTheDocument();
});

test('shows the awaiting-input indicator and jumps to the parked task on click', async () => {
  const onGotoAwaitingInput = vi.fn();
  const screen = render(<AwaitingInput onGotoAwaitingInput={onGotoAwaitingInput} />);
  await screen.getByText('2 awaiting input').click();
  expect(onGotoAwaitingInput).toHaveBeenCalled();
});

test('hides the awaiting-input indicator when nothing is parked', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Kanban Board')).toBeInTheDocument();
  expect(screen.container.querySelector('[aria-label*="awaiting your input"]')).toBeNull();
});

test('marks the active nav item with aria-current="page"', async () => {
  // Default renders view="board", so the Board nav item is active.
  const screen = render(<Default />);
  const active = screen.getByRole('button', { name: /Kanban Board/ });
  await expect.element(active).toHaveAttribute('aria-current', 'page');
  // A non-active item carries no aria-current.
  const inactive = screen.getByRole('button', { name: /Settings/ });
  expect(inactive.element().getAttribute('aria-current')).toBeNull();
});

test('the project switcher toggle exposes aria-haspopup and aria-expanded', async () => {
  const closed = render(<Default />);
  const toggle = closed.container.querySelector('button[aria-haspopup="menu"]');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');

  const open = render(<SwitcherOpen />);
  const openToggle = open.container.querySelector('button[aria-haspopup="menu"]');
  expect(openToggle?.getAttribute('aria-expanded')).toBe('true');
});
