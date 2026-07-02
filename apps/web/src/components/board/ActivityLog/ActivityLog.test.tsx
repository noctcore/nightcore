import { composeStories } from '@storybook/react-vite';
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
