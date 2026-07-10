import { composeStories } from '@storybook/react-vite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command surface underneath the bridge (the PrStatusCard.test
// seam) so `trust_report` / `trust_report_markdown` / `write_trust_report` are
// observable, and the save dialog is stubbable. The bridge gates real calls on
// `isTauri()`, satisfied by stubbing `window.__TAURI_INTERNALS__` in `beforeEach`.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const save = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...a: unknown[]) => save(...a),
  open: vi.fn(),
}));

import type { Task } from '@/lib/bridge';

import { makeTask, TRUST_VERIFIED } from '../_fixtures';
import { TrustReport } from './TrustReport';
import { exportFileName } from './TrustReport.hooks';
import * as stories from './TrustReport.stories';

const { Verified, GauntletFailed, Denials, Empty, Unavailable } = composeStories(stories);

const RUN_TASK: Task = makeTask({
  id: 'task-1',
  title: 'Wire up auth guard',
  status: 'done',
  runMode: 'worktree',
  branch: 'nc/auth-guard',
  verified: true,
});

/** The same run, but with a pull request — the "Attach to PR" action appears. */
const PR_TASK: Task = makeTask({
  ...RUN_TASK,
  prUrl: 'https://github.com/acme/widget/pull/7',
  prNumber: 7,
});

const PREVIEW_MD = '# Nightcore — Trust report\n\nPREVIEW-ONLY-MARKER line for the receipt body.';

/** Route the mocked invoke per command. */
function stubCommands(overrides: Record<string, (args: unknown) => Promise<unknown>> = {}) {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    const override = overrides[cmd as string];
    if (override !== undefined) return override(args);
    switch (cmd) {
      case 'trust_report':
        return Promise.resolve(TRUST_VERIFIED);
      case 'trust_report_markdown':
        return Promise.resolve(PREVIEW_MD);
      case 'write_trust_report':
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

// --- Presentational render states (the override seam — no fetch) -------------

test('the verified receipt shows the pass summary, verdict, and gauntlet checks', async () => {
  const screen = render(<Verified />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();
  await expect.element(screen.getByText(/VERDICT: PASS/)).toBeInTheDocument();
  // A structure-lock check name + its command from the fixture.
  await expect.element(screen.getByText('folder-per-component')).toBeInTheDocument();
  await expect.element(screen.getByText('npx eslint .')).toBeInTheDocument();
});

test('a failed gauntlet shows the failing check and changes-requested verdict', async () => {
  const screen = render(<GauntletFailed />);
  await expect.element(screen.getByText('× Not verified')).toBeInTheDocument();
  await expect.element(screen.getByText(/CHANGES REQUESTED/)).toBeInTheDocument();
});

test('denials render the denied digest, asked action, and policy hold', async () => {
  const screen = render(<Denials />);
  await expect.element(screen.getByText('cat ~/.aws/credentials')).toBeInTheDocument();
  await expect.element(screen.getByText(/Policy hold:/)).toBeInTheDocument();
});

test('an empty receipt renders quiet per-section empty notes, not zeroes', async () => {
  const screen = render(<Empty />);
  await expect
    .element(screen.getByText('Not yet verified — no gauntlet or reviewer result recorded.'))
    .toBeInTheDocument();
  await expect.element(screen.getByText('No tool calls evaluated yet.')).toBeInTheDocument();
  await expect.element(screen.getByText('No sessions recorded yet.')).toBeInTheDocument();
});

test('the outside-Tauri sentinel shows the quiet unavailable note', async () => {
  const screen = render(<Unavailable />);
  await expect
    .element(screen.getByText('Trust report is unavailable in the browser preview.'))
    .toBeInTheDocument();
});

// --- Export + preview over the mocked bridge + save dialog -------------------

test('Export saves the canonical markdown through write_trust_report', async () => {
  stubCommands();
  save.mockResolvedValue('/Users/dev/Desktop/trust-report.md');
  const screen = render(<TrustReport task={RUN_TASK} />);
  // The fetched report renders (no override → the mount fetch resolves).
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();

  await screen.getByRole('button', { name: /^export$/i }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('write_trust_report', {
      taskId: 'task-1',
      destPath: '/Users/dev/Desktop/trust-report.md',
    }),
  );
  // The save dialog defaults to a slugged filename from the task title.
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: `${exportFileName('Wire up auth guard')}.md` }),
  );
  await expect.element(screen.getByText(/Saved to/)).toBeInTheDocument();
});

test('cancelling the save dialog writes nothing', async () => {
  stubCommands();
  save.mockResolvedValue(null);
  const screen = render(<TrustReport task={RUN_TASK} />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();

  await screen.getByRole('button', { name: /^export$/i }).click();
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalledWith('write_trust_report', expect.anything());
});

test('Preview renders the canonical markdown from trust_report_markdown', async () => {
  stubCommands();
  const screen = render(<TrustReport task={RUN_TASK} />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();

  await screen.getByRole('button', { name: /^preview$/i }).click();
  await expect.element(screen.getByText(/PREVIEW-ONLY-MARKER/)).toBeInTheDocument();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('trust_report_markdown', {
      taskId: 'task-1',
      forGithub: false,
    }),
  );
});

// --- Attach to PR (PR 3): the human-gated GitHub comment post ----------------

test('the Attach to PR action is hidden for a task with no pull request', async () => {
  stubCommands();
  const screen = render(<TrustReport task={RUN_TASK} />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /attach to pr/i })).not.toBeInTheDocument();
});

test('Attach to PR posts the receipt through attach_trust_report_to_pr after the confirm', async () => {
  stubCommands();
  const screen = render(<TrustReport task={PR_TASK} />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();

  // Arm the confirm gate — nothing is posted yet.
  await screen.getByRole('button', { name: /attach to pr/i }).click();
  expect(invoke).not.toHaveBeenCalledWith('attach_trust_report_to_pr', expect.anything());

  // Confirm posts the comment for this task; a success note replaces the gate.
  await screen.getByRole('button', { name: /attach receipt/i }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('attach_trust_report_to_pr', { taskId: 'task-1' }),
  );
  await expect
    .element(screen.getByText(/Attached the receipt to the pull request/i))
    .toBeInTheDocument();
});

test('cancelling the confirm gate posts nothing', async () => {
  stubCommands();
  const screen = render(<TrustReport task={PR_TASK} />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();

  await screen.getByRole('button', { name: /attach to pr/i }).click();
  await screen.getByRole('button', { name: /^cancel$/i }).click();
  expect(invoke).not.toHaveBeenCalledWith('attach_trust_report_to_pr', expect.anything());
});

test('a failed attach surfaces the error inline and posts nothing further', async () => {
  stubCommands({
    attach_trust_report_to_pr: () => Promise.reject(new Error('HTTP 404: Not Found')),
  });
  const screen = render(<TrustReport task={PR_TASK} />);
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();

  await screen.getByRole('button', { name: /attach to pr/i }).click();
  await screen.getByRole('button', { name: /attach receipt/i }).click();
  await expect.element(screen.getByText(/Attach failed: HTTP 404: Not Found/i)).toBeInTheDocument();
});

test('exportFileName slugs a title into a safe *.md stem', () => {
  expect(exportFileName('Wire up auth guard')).toBe('trust-report-wire-up-auth-guard');
  expect(exportFileName('  !!!  ')).toBe('trust-report');
});
