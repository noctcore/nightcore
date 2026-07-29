import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { RunOrderProjection } from '@/lib/bridge';

import { makeTask } from '../_fixtures';
import { RunOrderProvider } from '../run-order';
import { RunOrderPanel } from './RunOrderPanel';
import * as stories from './RunOrderPanel.stories';

const { AllSlotsBusy, ChainedBoard, NothingQueued } = composeStories(stories);

/** The ordered rows' text, read off the DOM. Text locators can't be used here: a row's
 *  "waits on <predecessor>" line repeats an earlier row's title, so a title query resolves
 *  to two elements. */
function orderedRowText(body: Document): string[] {
  return [...body.querySelectorAll('ol > li')].map((li) => li.textContent ?? '');
}

test('lists the chain in projected execution order, not column order', async () => {
  const screen = render(<ChainedBoard />);
  const body = screen.container.ownerDocument;
  // Position 1 is the chain HEAD (oldest, unblocked) — the columns would show the
  // most-recently-updated card first instead.
  await vi.waitFor(() => expect(orderedRowText(body)).toHaveLength(3));
  const rows = orderedRowText(body);
  expect(rows[0]).toContain('Extract the settings store');
  expect(rows[1]).toContain('Add the rate limiter');
  expect(rows[2]).toContain('Wire up auth guard');
});

test('names each row’s live blockers by title', async () => {
  const screen = render(<ChainedBoard />);
  await expect
    .element(screen.getByText('waits on Extract the settings store'))
    .toBeInTheDocument();
});

test('draws the "starts now" cut line after the last wave-0 row', async () => {
  const screen = render(<ChainedBoard />);
  await expect.element(screen.getByText(/starts now · above/i)).toBeInTheDocument();
});

test('groups launchable tasks that can NEVER become eligible separately', async () => {
  const screen = render(<ChainedBoard />);
  await expect.element(screen.getByText(/never eligible \(1\)/i)).toBeInTheDocument();
  // `dead` gets NO position — it lives in the never-eligible <ul>, not the ordered <ol>.
  const body = screen.container.ownerDocument;
  expect(orderedRowText(body).join(' ')).not.toContain('Trim the shiki bundle');
  expect(body.querySelector('ul')?.textContent).toContain('Trim the shiki bundle');
});

test('reports the live slot context and the arm-preview summary in the header', async () => {
  const screen = render(<ChainedBoard />);
  await expect
    .element(screen.getByText(/2 of 3 slots free · Starts 1 task now · 2 then queued/))
    .toBeInTheDocument();
});

test('says nothing is queued rather than rendering an empty list', async () => {
  const screen = render(<NothingQueued />);
  await expect.element(screen.getByText(/nothing is queued to run/i)).toBeInTheDocument();
  expect(screen.container.ownerDocument.body.querySelector('ol')).toBeNull();
});

test('with every slot busy the queue is still legible and nothing starts now', async () => {
  const screen = render(<AllSlotsBusy />);
  const body = screen.container.ownerDocument;
  await vi.waitFor(() => expect(orderedRowText(body)).toHaveLength(3));
  expect(orderedRowText(body)[0]).toContain('Extract the settings store');
  // No wave-0 row ⇒ no cut line to draw.
  expect(body.body.textContent).not.toMatch(/starts now · above/i);
});

test('keyboard path: a row is reachable and opens its task on Enter', async () => {
  const onSelectTask = vi.fn();
  const projection: RunOrderProjection = {
    entries: [{ taskId: 'solo', position: 1, wave: 0, startsNow: true, blockedBy: [] }],
    unreachable: [],
    freeSlots: 1,
    maxConcurrency: 1,
    startsNowCount: 1,
  };
  const screen = render(
    <RunOrderProvider value={projection}>
      <RunOrderPanel
        open
        tasks={[makeTask({ id: 'solo', title: 'Only queued task' })]}
        onClose={() => {}}
        onSelectTask={onSelectTask}
      />
    </RunOrderProvider>,
  );
  const row = screen.getByRole('button', {
    name: 'Open Only queued task — run order position 1',
  });
  await expect.element(row).toBeInTheDocument();
  await userEvent.click(row);
  expect(onSelectTask).toHaveBeenCalledWith('solo');
});

test('renders rows inert (no buttons) when no open handler is wired', async () => {
  const projection: RunOrderProjection = {
    entries: [{ taskId: 'solo', position: 1, wave: 0, startsNow: true, blockedBy: [] }],
    unreachable: [],
    freeSlots: 1,
    maxConcurrency: 1,
    startsNowCount: 1,
  };
  const screen = render(
    <RunOrderProvider value={projection}>
      <RunOrderPanel
        open
        tasks={[makeTask({ id: 'solo', title: 'Only queued task' })]}
        onClose={() => {}}
      />
    </RunOrderProvider>,
  );
  await expect.element(screen.getByText('Only queued task')).toBeInTheDocument();
  // The row renders as a plain <div>, so no button carries the task title.
  expect(
    screen.container.ownerDocument.body.querySelector('ol button'),
  ).toBeNull();
});
