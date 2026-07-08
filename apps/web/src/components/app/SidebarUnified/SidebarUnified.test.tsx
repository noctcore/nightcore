import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ProjectSwitcherSurface } from '../Sidebar/Sidebar.types';
import * as stories from './SidebarUnified.stories';

const { Default } = composeStories(stories);

test('shows active project name', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByTitle('nightcore')).toBeInTheDocument();
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
