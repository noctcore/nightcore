import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { TASKS_BY_STATUS } from '../_fixtures';
import { resolveDrop } from './BoardDnd.hooks';
import * as stories from './BoardDnd.stories';

const { WrapsColumns } = composeStories(stories);

const TASKS = [TASKS_BY_STATUS.backlog, TASKS_BY_STATUS.done, TASKS_BY_STATUS.in_progress];

test('resolveDrop moves a card dropped on a different, droppable column', () => {
  expect(resolveDrop('t-backlog', 'done', TASKS)).toEqual({ id: 't-backlog', status: 'done' });
});

test('resolveDrop is a no-op when the column matches the card status', () => {
  expect(resolveDrop('t-done', 'done', TASKS)).toBeNull();
});

test('resolveDrop is a no-op for a ready card dropped on its own Backlog column', () => {
  // The Backlog column groups `backlog`+`ready` under one droppable (primary id
  // `backlog`); a `ready` card dropped back on it must NOT silently demote to backlog.
  const ready = { ...TASKS_BY_STATUS.backlog, id: 't-ready', status: 'ready' as const };
  expect(resolveDrop('t-ready', 'backlog', [...TASKS, ready])).toBeNull();
});

test('resolveDrop rejects a drop onto In Progress (run-only target)', () => {
  expect(resolveDrop('t-backlog', 'in_progress', TASKS)).toBeNull();
});

test('resolveDrop rejects a drop onto Verifying (engine-owned — no manual entry)', () => {
  // Verifying holds a live reviewer session and pins its cards; it must be an inert
  // drop target, or a card would strand in a running-looking state with no session.
  expect(resolveDrop('t-backlog', 'verifying', TASKS)).toBeNull();
});

test('resolveDrop ignores a pinned (running) card', () => {
  expect(resolveDrop('t-running', 'backlog', TASKS)).toBeNull();
});

test('resolveDrop is a no-op for a drop outside any column', () => {
  expect(resolveDrop('t-backlog', null, TASKS)).toBeNull();
});

test('resolveDrop ignores an unknown card id', () => {
  expect(resolveDrop('does-not-exist', 'done', TASKS)).toBeNull();
});

test('renders the wrapped columns inside the drag context', async () => {
  const screen = render(<WrapsColumns />);
  await expect
    .element(screen.getByRole('heading', { name: 'Backlog', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Done', level: 2 }))
    .toBeInTheDocument();
});

test('a draggable card inside the context exposes the grab affordance', async () => {
  const screen = render(<WrapsColumns />);
  // Wait for the (virtualized) Done card to mount, then assert the grab handle.
  await expect.element(screen.getByText('Wire up auth guard')).toBeInTheDocument();
  expect(screen.container.querySelector('.cursor-grab')).not.toBeNull();
});

test('dragging a card onto a different column relays onMoveTask (collision detection)', async () => {
  const onMoveTask = vi.fn();
  const screen = render(<WrapsColumns onMoveTask={onMoveTask} />);
  await expect.element(screen.getByText('Wire up auth guard')).toBeInTheDocument();

  const grab = screen.container.querySelector('.cursor-grab') as HTMLElement;
  const doneColumn = [...screen.container.querySelectorAll('[aria-dropeffect]')].find((c) =>
    c.textContent?.includes('Done'),
  ) as HTMLElement;

  const from = grab.getBoundingClientRect();
  const to = doneColumn.getBoundingClientRect();
  const fx = from.x + from.width / 2;
  const fy = from.y + 20;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const fire = (type: string, x: number, y: number, target: Element) =>
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true }),
    );

  fire('pointerdown', fx, fy, grab);
  fire('pointermove', fx + 4, fy, document.body);
  fire('pointermove', fx + 12, fy, document.body);
  fire('pointermove', (fx + tx) / 2, (fy + ty) / 2, document.body);
  fire('pointermove', tx, ty, document.body);
  fire('pointermove', tx, ty, document.body);
  await new Promise((r) => setTimeout(r, 20));
  fire('pointerup', tx, ty, document.body);
  await new Promise((r) => setTimeout(r, 20));

  expect(onMoveTask).toHaveBeenCalledWith('t-backlog', 'done');
});
