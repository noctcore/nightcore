import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './Board.stories';

const { Empty, Populated, AutoModeOn, CircuitBreakerPaused, UsagePaused, UsagePausedNoReset } =
  composeStories(stories);

test('renders all five board columns, including the Done label', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByRole('heading', { name: 'Backlog', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'In Progress', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Waiting Approval', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Done', level: 2 }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('heading', { name: 'Failed', level: 2 }))
    .toBeInTheDocument();
});

test('renders the project path and branch in the header subtitle', async () => {
  const screen = render(<Populated />);
  await expect.element(screen.getByText('~/dev/nightcore')).toBeInTheDocument();
  // The header subtitle pairs the project branch with the kanban title; assert it
  // there (main-mode cards also carry a "main" chip, so a bare text query is
  // ambiguous on a populated board).
  const heading = screen.getByRole('heading', { name: /kanban board/i });
  await expect.element(heading).toBeInTheDocument();
});

test('reflects the live loop state on the Auto Mode toggle', async () => {
  const screen = render(<AutoModeOn />);
  await expect
    .element(screen.getByRole('button', { name: 'Auto Mode', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('surfaces the circuit-breaker Resume banner when the loop has paused', async () => {
  const screen = render(<CircuitBreakerPaused />);
  await expect
    .element(screen.getByText(/paused after 3 consecutive failures/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /resume/i }))
    .toBeInTheDocument();
});

test('surfaces the usage-pause banner with the hottest window + reset clock', async () => {
  const screen = render(<UsagePaused />);
  // The copy names the provider + window + percent, and there is NO Resume button
  // (the loop auto-resumes when usage cools) — only a Dismiss.
  await expect
    .element(screen.getByText(/auto mode paused — claude session \(5h\) at 94%, resumes ~/i))
    .toBeInTheDocument();
  expect(screen.container.querySelector('button[aria-label="Dismiss"]')).not.toBeNull();
  await expect
    .element(screen.getByText(/consecutive failures/i))
    .not.toBeInTheDocument();
});

test('dismissing the usage-pause banner hides it', async () => {
  const screen = render(<UsagePaused />);
  const banner = screen.getByText(/auto mode paused — claude session \(5h\)/i);
  await expect.element(banner).toBeInTheDocument();
  // The usage banner's Dismiss is the second one on the board (breaker is absent), so
  // target it via the banner text's ancestor.
  const dismiss = screen
    .container.querySelectorAll('button[aria-label="Dismiss"]');
  (dismiss[dismiss.length - 1] as HTMLButtonElement).click();
  await expect.element(banner).not.toBeInTheDocument();
});

test('the usage-pause banner drops the resumes clause when there is no reset', async () => {
  const screen = render(<UsagePausedNoReset />);
  await expect
    .element(screen.getByText(/auto mode paused — claude weekly at 97%/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/resumes ~/i))
    .not.toBeInTheDocument();
});
