import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { formatElapsed, subscribeSecondTick } from './TaskCard.hooks';
import * as stories from './TaskCard.stories';

const { Backlog, Failed, Done, Blocked, Running, Verifying, MainMode, MainModeCommitted, Draggable } =
  composeStories(stories);

test('shows the reviewing chip and a cancel control while verifying', async () => {
  const screen = render(<Verifying />);
  await expect.element(screen.getByText('reviewing')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /cancel run/i }))
    .toBeInTheDocument();
});

test('shows the verified badge on a passed task', async () => {
  const screen = render(<Done />);
  await expect.element(screen.getByText('verified')).toBeInTheDocument();
});

test('shows the error line on a failed task', async () => {
  const screen = render(<Failed />);
  await expect
    .element(screen.getByText("cannot resolve 'sass-loader'"))
    .toBeInTheDocument();
});

test('calls onSelect with the task id when the card body is clicked', async () => {
  const onSelect = vi.fn();
  const screen = render(<Done onSelect={onSelect} />);
  await screen.getByRole('button', { name: /wire up auth guard/i }).click();
  expect(onSelect).toHaveBeenCalledWith('t-done');
});

test('resolves the model id to its display name', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('Sonnet 4.8')).toBeInTheDocument();
});

test('disables the run action and shows a Blocked label when blocked', async () => {
  const screen = render(<Blocked />);
  const blockedBtn = screen.getByRole('button', { name: /^blocked$/i });
  await expect.element(blockedBtn).toBeDisabled();
});

test('calls onCancel from the running card', async () => {
  const onCancel = vi.fn();
  const screen = render(<Running onCancel={onCancel} />);
  await screen.getByRole('button', { name: /cancel run/i }).click();
  expect(onCancel).toHaveBeenCalledWith('t-running');
});

test('renders the branch chip from task.branch', async () => {
  const screen = render(<Done />);
  await expect.element(screen.getByText('nc/auth-guard')).toBeInTheDocument();
});

test('renders a "main" chip for a main-mode task instead of a branch', async () => {
  const screen = render(<MainMode />);
  await expect.element(screen.getByText('main')).toBeInTheDocument();
});

test('suppresses Merge for a committed main-mode task', async () => {
  const screen = render(<MainModeCommitted />);
  const committed = screen.getByRole('button', { name: /committed/i });
  await expect.element(committed).toBeDisabled();
  expect(screen.container.querySelector('button')).not.toBeNull();
  await expect.element(screen.getByText('Committed')).toBeInTheDocument();
});

test('a draggable card carries the grab affordance and keyboard-draggable attributes (a11y)', async () => {
  const screen = render(<Draggable />);
  // The whole card is the @dnd-kit drag handle: grab cursor + focusable with the
  // draggable role — the keyboard move path that replaces the old move menu.
  const root = screen.container.querySelector('.cursor-grab');
  expect(root).not.toBeNull();
  expect(root?.getAttribute('aria-roledescription')).toBe('draggable');
  expect(root?.getAttribute('tabindex')).toBe('0');
});

test('a non-draggable card exposes no drag affordance', async () => {
  const screen = render(<Backlog />);
  expect(screen.container.querySelector('.cursor-grab')).toBeNull();
});

test('formatElapsed renders mm:ss and clamps negatives to 00:00', () => {
  expect(formatElapsed(0)).toBe('00:00');
  expect(formatElapsed(65_000)).toBe('01:05');
  expect(formatElapsed(-5_000)).toBe('00:00');
});

test('subscribeSecondTick shares ONE interval across cards and stops when the last detaches', () => {
  vi.useFakeTimers();
  try {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeSecondTick(a);
    const offB = subscribeSecondTick(b);
    // Two subscribers, but only one interval is scheduled.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);

    // One card detaches — the shared interval keeps ticking for the rest.
    offA();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(4);

    // Last subscriber gone → the interval is torn down (no idle timer).
    offB();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
