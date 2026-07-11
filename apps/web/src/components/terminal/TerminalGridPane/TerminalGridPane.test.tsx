import { DndContext } from '@dnd-kit/core';
import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import type { TerminalSessionInfo } from '@/lib/bridge';

import { TerminalGridPane } from './TerminalGridPane';
import * as stories from './TerminalGridPane.stories';

const { Default, Zoomed, Broadcasting } = composeStories(stories);

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
    titleSource: null,
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

test('a broadcasting pane shows the LOUD BCAST indicator + amber ring (round-2 PR B)', async () => {
  const screen = render(<Broadcasting />);
  await expect.element(screen.getByText('BCAST')).toBeInTheDocument();
  await expect
    .element(screen.getByLabelText('Receiving broadcast input'))
    .toBeInTheDocument();
  // The receiving ring lands on the `data-session-id` pane root (an unmissable footgun cue).
  const root = screen.container.querySelector('[data-session-id]');
  expect(root?.className).toContain('ring-amber-400/80');
});

test('a non-broadcasting pane shows no BCAST indicator', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByRole('button', { name: /Maximize pane/ })).toBeInTheDocument();
  expect(screen.container.querySelector('[aria-label="Receiving broadcast input"]')).toBeNull();
});

test('double-clicking the title opens the inline rename and commits on Enter', async () => {
  const onRename = vi.fn();
  const screen = render(
    <ToastProvider>
      <DndContext>
        <TerminalGridPane
          session={fakeSession({ title: 'deploy shell' })}
          unread={0}
          ungoverned={false}
          canLaunch={false}
          zoomed={false}
          draggable
          broadcasting={false}
          isDropTarget={false}
          onRename={onRename}
          onLaunchClaude={() => {}}
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
          ungoverned={false}
          canLaunch={false}
          zoomed={false}
          draggable
          broadcasting={false}
          isDropTarget={false}
          onRename={() => {}}
          onLaunchClaude={() => {}}
          onToggleZoom={() => {}}
          onActivate={onActivate}
        />
      </DndContext>
    </ToastProvider>,
  );
  await userEvent.click(screen.getByText('shell one').element());
  expect(onActivate).toHaveBeenCalledWith('grid-session');
});

test('shows the Launch Claude button when canLaunch and fires onLaunchClaude', async () => {
  const onLaunchClaude = vi.fn();
  const screen = render(
    <ToastProvider>
      <DndContext>
        <TerminalGridPane
          session={fakeSession({})}
          unread={0}
          ungoverned={false}
          canLaunch
          zoomed={false}
          draggable
          broadcasting={false}
          isDropTarget={false}
          onRename={() => {}}
          onLaunchClaude={onLaunchClaude}
          onToggleZoom={() => {}}
          onActivate={() => {}}
        />
      </DndContext>
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Launch Claude' }).element());
  expect(onLaunchClaude).toHaveBeenCalledTimes(1);
});

test('hides the Launch Claude button on a non-POSIX (canLaunch=false) pane', () => {
  const screen = render(
    <ToastProvider>
      <DndContext>
        <TerminalGridPane
          session={fakeSession({})}
          unread={0}
          ungoverned={false}
          canLaunch={false}
          zoomed={false}
          draggable
          broadcasting={false}
          isDropTarget={false}
          onRename={() => {}}
          onLaunchClaude={() => {}}
          onToggleZoom={() => {}}
          onActivate={() => {}}
        />
      </DndContext>
    </ToastProvider>,
  );
  expect(screen.container.querySelector('[aria-label="Launch Claude"]')).toBeNull();
});
