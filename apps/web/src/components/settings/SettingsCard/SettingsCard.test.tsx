import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './SettingsCard.stories';

const { Models, ScopeOnGlobalTab, ScopeOnProjectTab } = composeStories(stories);

test('renders the card title and its rows', async () => {
  const screen = render(<Models />);
  await expect.element(screen.getByText('Models', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Default model', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Reasoning effort', { exact: true })).toBeInTheDocument();
});

test('shows no scope badges on a page with no per-project choice', async () => {
  const screen = render(<Models />);
  // No `scopeSurface` ⇒ the page is global end to end and says so in its header.
  await expect.element(screen.getByText('Global', { exact: true })).not.toBeInTheDocument();
});

test('a per-project row on the global tab deep-links to the project override', async () => {
  const onScopeChange = vi.fn();
  const screen = render(
    <ScopeOnGlobalTab
      scopeSurface={{ scope: 'global', projectName: 'nightcore', onScopeChange }}
    />,
  );
  // `permissionMode` IS a field of the Rust override shape, so it is overridable…
  const jump = screen.getByRole('button', {
    name: 'Global default — set this for nightcore only',
  });
  await jump.click();
  expect(onScopeChange).toHaveBeenCalledWith('project');

  // …while `sandboxSessions` is not: it stays global even on the project tab.
  await expect.element(screen.getByText('Global', { exact: true })).toBeInTheDocument();
});

test('a per-project row on the project tab names the project and links back', async () => {
  const onScopeChange = vi.fn();
  const screen = render(
    <ScopeOnProjectTab
      scopeSurface={{ scope: 'project', projectName: 'nightcore', onScopeChange }}
    />,
  );
  const back = screen.getByRole('button', {
    name: 'Applies to nightcore only — edit the global default instead',
  });
  await back.click();
  expect(onScopeChange).toHaveBeenCalledWith('global');
});

test('with no project open, an overridable row is described but not settable', async () => {
  const screen = render(
    <ScopeOnGlobalTab
      scopeSurface={{ scope: 'global', projectName: null, onScopeChange: vi.fn() }}
    />,
  );
  await expect.element(screen.getByText('Per-project', { exact: true })).toBeInTheDocument();
});
