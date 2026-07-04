import { composeStories } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { EMPTY_STREAM, type SessionGroup, type TimelineEntry } from '../session-stream';
import { ActivityLog } from './ActivityLog';
import * as stories from './ActivityLog.stories';

const { Empty, WaitingForToken, SingleSession, MultiSession, WithError } =
  composeStories(stories);

/** Wrap a timeline in a single build session (rendered inline, no chrome). */
function oneSession(entries: TimelineEntry[]): SessionGroup[] {
  return [
    { index: 1, sdkSessionId: null, model: null, prompt: null, phase: 'build', stream: { ...EMPTY_STREAM, entries } },
  ];
}

/** A short, fixed-height overflow container mimicking TaskDetail's shared scroll
 *  region — the auto-follow hook walks up to it as the scrollable ancestor. */
function Scroller({ children }: { children: ReactNode }) {
  return (
    <div data-testid="scroll" style={{ height: '120px', overflowY: 'auto' }}>
      {children}
    </div>
  );
}

/** N sealed text turns — enough to overflow the 120px Scroller. */
function manyEntries(n: number): TimelineEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'text' as const,
    id: i + 1,
    markdown: `Transcript line number ${i + 1}`,
    closed: true,
  }));
}

/** Distance (px) from the container's scrolled position to its very bottom. */
function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

test('renders the run-this-task prompt when there is no activity', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByRole('heading', { name: 'Activity' }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/run this task to stream its transcript/i))
    .toBeInTheDocument();
});

test('shows the live heading and the waiting prompt while running', async () => {
  const screen = render(<WaitingForToken />);
  await expect
    .element(screen.getByRole('heading', { name: 'Live activity' }))
    .toBeInTheDocument();
  await expect.element(screen.getByText(/Waiting for first token/i)).toBeInTheDocument();
});

test('renders a single session inline without collapsible chrome', async () => {
  const screen = render(<SingleSession />);
  await expect
    .element(screen.getByText(/Adding the auth middleware/i))
    .toBeInTheDocument();
  // The inline single-session view has no per-session toggle button.
  expect(screen.container.querySelector('button[aria-expanded]')).toBeNull();
});

test('renders multiple sessions as collapsible blocks with the latest open', async () => {
  const screen = render(<MultiSession />);
  const toggles = screen.container.querySelectorAll('button[aria-expanded]');
  expect(toggles.length).toBe(2);
  // The latest (verification) session opens by default.
  await expect
    .element(screen.getByText(/Reviewing the diff against the base branch/i))
    .toBeInTheDocument();
});

test('renders a terminal session error in place of the timeline', async () => {
  const screen = render(<WithError />);
  await expect
    .element(screen.getByText("cannot resolve 'sass-loader'"))
    .toBeInTheDocument();
});

test('a streaming turn mutated in place still updates on screen', async () => {
  // Reproduces foldSession's in-place append: the open text entry keeps its
  // object identity while its markdown grows. The memoized row must track the
  // markdown SNAPSHOT prop, not `entry` identity — otherwise a memo on identity
  // alone would freeze the live turn on screen as it streams.
  const open: TimelineEntry = { kind: 'text', id: 2, markdown: 'Investigating', closed: false };
  const entries: TimelineEntry[] = [
    { kind: 'text', id: 1, markdown: 'Sealed intro turn.', closed: true },
    { kind: 'tool', id: 1, toolName: 'Grep' },
    open,
  ];
  const screen = render(<ActivityLog sessions={oneSession(entries)} isRunning />);
  await expect.element(screen.getByText('Investigating')).toBeInTheDocument();

  // Grow the open turn in place (same object ref, new markdown) and hand React a
  // fresh sessions object — exactly what foldTranscript returns on each flush.
  open.markdown += ' the auth token refresh path';
  screen.rerender(<ActivityLog sessions={oneSession(entries)} isRunning />);
  await expect
    .element(screen.getByText(/Investigating the auth token refresh path/))
    .toBeInTheDocument();
  // The sealed turn above is untouched by the trailing-row update.
  await expect.element(screen.getByText('Sealed intro turn.')).toBeInTheDocument();
});

test('sticks to the newest streamed entry while the user is at the bottom', async () => {
  const entries = manyEntries(14);
  const screen = render(
    <Scroller>
      <ActivityLog sessions={oneSession(entries)} isRunning />
    </Scroller>,
  );
  const scroll = screen.container.querySelector('[data-testid="scroll"]') as HTMLElement;

  // Follow is on by default → the mount effect already parked us at the tail.
  await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(4);

  // A new streamed entry appends below the fold; the follow effect pulls it in.
  const grown: TimelineEntry[] = [
    ...entries,
    { kind: 'text', id: 99, markdown: 'The very newest streamed token', closed: false },
  ];
  screen.rerender(
    <Scroller>
      <ActivityLog sessions={oneSession(grown)} isRunning />
    </Scroller>,
  );
  await expect.element(screen.getByText('The very newest streamed token')).toBeInTheDocument();
  await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(4);
});

test('does NOT yank the view back when the user has scrolled up to read history', async () => {
  const entries = manyEntries(14);
  const screen = render(
    <Scroller>
      <ActivityLog sessions={oneSession(entries)} isRunning />
    </Scroller>,
  );
  const scroll = screen.container.querySelector('[data-testid="scroll"]') as HTMLElement;

  // The user scrolls up to the top to read earlier output — auto-follow suspends.
  scroll.scrollTop = 0;
  scroll.dispatchEvent(new Event('scroll'));

  const grown: TimelineEntry[] = [
    ...entries,
    { kind: 'text', id: 99, markdown: 'A later streamed token', closed: false },
  ];
  screen.rerender(
    <Scroller>
      <ActivityLog sessions={oneSession(grown)} isRunning />
    </Scroller>,
  );
  await expect.element(screen.getByText('A later streamed token')).toBeInTheDocument();
  // Give any stray follow effect a chance to fire, then assert we stayed put.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  expect(scroll.scrollTop).toBeLessThan(4);
});

test('caps a long transcript to its trailing window and reveals earlier on demand', async () => {
  // 75 entries with a 60-entry page: the newest 60 mount, the oldest 15 hide.
  const entries = manyEntries(75);
  const screen = render(<ActivityLog sessions={oneSession(entries)} isRunning={false} />);

  // The tail is always mounted; the very first (oldest) entry is withheld.
  await expect
    .element(screen.getByText('Transcript line number 75', { exact: true }))
    .toBeInTheDocument();
  expect(screen.container.querySelector('ol')?.querySelectorAll('li').length).toBe(60);
  expect(screen.getByText('Transcript line number 1', { exact: true }).query()).toBeNull();

  // The "show earlier" affordance reveals the withheld page.
  await screen.getByRole('button', { name: /show 15 earlier entries/i }).click();
  await expect
    .element(screen.getByText('Transcript line number 1', { exact: true }))
    .toBeInTheDocument();
  expect(screen.container.querySelector('ol')?.querySelectorAll('li').length).toBe(75);
});
