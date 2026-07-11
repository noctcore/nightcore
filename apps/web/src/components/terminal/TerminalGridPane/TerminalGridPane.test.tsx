import { DndContext } from '@dnd-kit/core';
import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { TerminalGridPane } from './TerminalGridPane';
import * as stories from './TerminalGridPane.stories';

const { Default, Zoomed } = composeStories(stories);

function fakeSession(over: Partial<TerminalSessionInfo>): TerminalSessionInfo {
  return {
    id: 'grid-session',
    cwd: '/Users/dev/nightcore',
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: 0,
    title: null,
    ...over,
  };
}

test('renders the reorder grip + maximize control on a draggable pane', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByRole('button', { name: /Reorder/ })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /Maximize pane/ })).toBeInTheDocument();
});

test('a zoomed pane shows Restore and drops the reorder grip', async () => {
  const screen = render(<Zoomed />);
  await expect.element(screen.getByRole('button', { name: /Restore grid/ })).toBeInTheDocument();
  expect(screen.container.querySelector('[aria-label^="Reorder"]')).toBeNull();
});

test('double-clicking the title opens the inline rename and commits on Enter', async () => {
  const onRename = vi.fn();
  const screen = render(
    <ToastProvider>
      <DndContext>
        <TerminalGridPane
          session={fakeSession({ title: 'deploy shell' })}
          unread={0}
          zoomed={false}
          draggable
          onRename={onRename}
          onToggleZoom={() => {}}
          onActivate={() => {}}
        />
      </DndContext>
    </ToastProvider>,
  );
  await userEvent.dblClick(screen.getByText('deploy shell').element());
  const input = screen.getByRole('textbox', { name: /Rename/ });
  await input.fill('build shell');
  await userEvent.keyboard('{Enter}');
  expect(onRename).toHaveBeenCalledWith('grid-session', 'build shell');
});

test('clicking the title activates the pane (the zoom target)', async () => {
  const onActivate = vi.fn();
  const screen = render(
    <ToastProvider>
      <DndContext>
        <TerminalGridPane
          session={fakeSession({ title: 'shell one' })}
          unread={0}
          zoomed={false}
          draggable
          onRename={() => {}}
          onToggleZoom={() => {}}
          onActivate={onActivate}
        />
      </DndContext>
    </ToastProvider>,
  );
  await userEvent.click(screen.getByText('shell one').element());
  expect(onActivate).toHaveBeenCalledWith('grid-session');
});
