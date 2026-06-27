import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './Sidebar.stories';

const { Default, SwitcherOpen, Running } = composeStories(stories);

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
