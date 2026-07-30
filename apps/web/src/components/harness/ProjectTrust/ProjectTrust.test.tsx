import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './ProjectTrust.stories';

const { CorruptJournal, Default, Loading, Unmeasured } = composeStories(stories);

test('the headline numbers carry the denominators that make them honest', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('28', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('of 31 merged · 46 tasks', { exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('94%', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('32 of 34 runs passed', { exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/22 from your policy/)).toBeInTheDocument();
  await expect.element(screen.getByText('$41.87', { exact: true })).toBeInTheDocument();
});

test('the badge renders exactly what publishing it would show', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByLabelText(/governance badge/i))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText('28 verified merges · 94% gauntlet · 35 denials', { exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/shields endpoint · green/)).toBeInTheDocument();
});

test('the journal feed labels each governance decision and dates it', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('Quarantined', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Policy saved', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('Disarmed', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('docs/vendor/CHANGELOG.md', { exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByText('2026-07-29 13:58', { exact: true })).toBeInTheDocument();
});

test('a record from a newer build is shown verbatim, never swallowed', async () => {
  const screen = render(<Default />);
  await expect.element(screen.getByText('future-kind', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText('something a newer build recorded', { exact: true }))
    .toBeInTheDocument();
});

test('a repo that never ran a gate says so instead of claiming 0%', async () => {
  const screen = render(<Unmeasured />);
  await expect.element(screen.getByText('—', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('never run', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText('not measured', { exact: true })).toBeInTheDocument();
  await expect
    .element(screen.getByText(/no governance decisions recorded/i))
    .toBeInTheDocument();
});

test('a corrupt journal states what was skipped rather than hiding it', async () => {
  const screen = render(<CorruptJournal />);
  await expect
    .element(screen.getByText(/3 unreadable line\(s\) in the journal were skipped/))
    .toBeInTheDocument();
});

test('a pending read shows a skeleton rather than an empty posture', async () => {
  const screen = render(<Loading />);
  const status = screen.container.querySelector('[role="status"][aria-busy="true"]');
  expect(status).not.toBeNull();
  expect(screen.container.textContent).not.toContain('not measured');
});

test('refresh and badge export are reachable and fire exactly once', async () => {
  const onRefresh = vi.fn();
  const onExportBadge = vi.fn();
  const screen = render(<Default onRefresh={onRefresh} onExportBadge={onExportBadge} />);
  await screen.getByRole('button', { name: /refresh/i }).click();
  await screen.getByRole('button', { name: /export badge/i }).click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(onExportBadge).toHaveBeenCalledTimes(1);
});

test('badge export is unavailable until a summary has loaded', async () => {
  const screen = render(<Loading />);
  await expect.element(screen.getByRole('button', { name: /export badge/i })).toBeDisabled();
  await expect.element(screen.getByRole('button', { name: /refresh/i })).toBeDisabled();
});
