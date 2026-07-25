import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ProjectSwitcherSurface } from '../Sidebar/Sidebar.types';
import * as stories from './SidebarUnified.stories';

const { Default } = composeStories(stories);

/** Spread the story's switcher surface with per-test overrides. */
function switcherWith(overrides: Partial<ProjectSwitcherSurface>): ProjectSwitcherSurface {
  return { ...(Default.args.switcher as ProjectSwitcherSurface), ...overrides };
}

test('shows active project name', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByTitle('nightcore')).toBeInTheDocument();
});

test('marks the active project row when the switcher is open', async () => {
  const screen = render(<Default switcher={switcherWith({ switcherOpen: true })} />);
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[aria-current="true"]')).not.toBeNull();
  });
});

test('closes the switcher on Escape', async () => {
  const onCloseSwitcher = vi.fn();
  render(<Default switcher={switcherWith({ switcherOpen: true, onCloseSwitcher })} />);
  await userEvent.keyboard('{Escape}');
  expect(onCloseSwitcher).toHaveBeenCalled();
});

test('requests removal from the active-project context menu', async () => {
  const onRemoveProject = vi.fn();
  const screen = render(
    <Default
      switcher={{
        ...(Default.args.switcher as ProjectSwitcherSurface),
        onRemoveProject,
      }}
    />,
  );

  screen.getByTitle('nightcore').element().dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  await screen.getByRole('menuitem', { name: 'Remove from Nightcore' }).click();

  expect(onRemoveProject).toHaveBeenCalledWith('p1');
});
