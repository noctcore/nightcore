import { userEvent } from '@vitest/browser/context';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command + event surface underneath the bridge (the CreatePRDialog
// seam) so `previewIssueMap` / `exportIssueMap` are observable. The bridge gates
// real calls on `isTauri()`, satisfied by stubbing `window.__TAURI_INTERNALS__`.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { IssueMapDialog } from './IssueMapDialog';
import { DEGRADED_RESULT, makePreview, PARTIAL_RESULT, SUCCESS_RESULT } from './IssueMapDialog.fixtures';

/** Route the mocked invoke per command; tests override single commands. */
function stubCommands(overrides: Record<string, (args: unknown) => Promise<unknown>> = {}) {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    const override = overrides[cmd as string];
    if (override !== undefined) return override(args);
    switch (cmd) {
      case 'preview_issue_map':
        return Promise.resolve(makePreview());
      case 'export_issue_map':
        return Promise.resolve(SUCCESS_RESULT);
      default:
        return Promise.resolve(undefined);
    }
  });
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test('fetches and renders the preview: parent body + every sub-issue title', async () => {
  stubCommands();
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={() => {}} />,
  );
  await expect
    .element(screen.getByText('Unhandled promise rejection in the sync worker'))
    .toBeInTheDocument();
  // A sub-issue title unique to the list (the parent body only carries the
  // shorter bolded lead-ins, so this asserts the list, not the markdown).
  await expect
    .element(screen.getByText('Off-by-one in pagination bounds'))
    .toBeInTheDocument();
  // The confirm footer states exactly what will happen.
  await expect.element(screen.getByText(/Open/).first()).toBeInTheDocument();
});

test('Enter does NOT confirm — export is never invoked', async () => {
  stubCommands();
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={() => {}} />,
  );
  await expect
    .element(screen.getByRole('button', { name: /export to github/i }))
    .toBeInTheDocument();
  await userEvent.keyboard('{Enter}');
  // The dialog is still in preview state and no GitHub write fired.
  await expect
    .element(screen.getByRole('button', { name: /export to github/i }))
    .toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith('export_issue_map', expect.anything());
});

test('confirm invokes export_issue_map with the previewed narrative + timestamp', async () => {
  stubCommands();
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={() => {}} />,
  );
  await screen.getByRole('button', { name: /export to github/i }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('export_issue_map', {
      scanKind: 'insight',
      runId: 'run-abc',
      generatedAt: '2026-07-11T00:00:00Z',
      narrative: makePreview().narrative,
      closeSuperseded: false,
    }),
  );
  // Full success → the parent link + Done.
  await expect.element(screen.getByText(/Exported map with 6 sub-issues/i)).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
});

test('the supersede checkbox threads closeSuperseded through the export', async () => {
  stubCommands({
    preview_issue_map: () =>
      Promise.resolve(
        makePreview({
          supersedes: {
            number: 101,
            title: 'Nightcore Insight map — 9 findings',
            url: 'https://github.com/acme/widget/issues/101',
          },
        }),
      ),
  });
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={() => {}} />,
  );
  // The checkbox <input> is sr-only; click the visible label text.
  await screen.getByText(/Close the superseded map #101 and its open sub-issues/i).click();
  await screen.getByRole('button', { name: /export to github/i }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'export_issue_map',
      expect.objectContaining({ closeSuperseded: true }),
    ),
  );
});

test('a PARTIAL result surfaces "nothing deleted" and the parent link (nothing rolled back)', async () => {
  stubCommands({ export_issue_map: () => Promise.resolve(PARTIAL_RESULT) });
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={() => {}} />,
  );
  await screen.getByRole('button', { name: /export to github/i }).click();
  await expect
    .element(screen.getByText(/Partial export — created 3 of 6 sub-issues/i))
    .toBeInTheDocument();
  await expect.element(screen.getByText(/Nothing was deleted/i)).toBeInTheDocument();
});

test('a DEGRADED result surfaces the task-list linkage fallback', async () => {
  stubCommands({ export_issue_map: () => Promise.resolve(DEGRADED_RESULT) });
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={() => {}} />,
  );
  await screen.getByRole('button', { name: /export to github/i }).click();
  await expect.element(screen.getByText(/task-list linkage/i)).toBeInTheDocument();
});

test('a hard rejection surfaces the inline error and keeps the dialog open', async () => {
  stubCommands({
    export_issue_map: () => Promise.reject(new Error('gh: authentication required')),
  });
  const onClose = vi.fn();
  const screen = render(
    <IssueMapDialog open scanKind="insight" runId="run-abc" onClose={onClose} />,
  );
  await screen.getByRole('button', { name: /export to github/i }).click();
  await expect.element(screen.getByText('gh: authentication required')).toBeInTheDocument();
  // Still open (the Export button is back) and never closed.
  await expect
    .element(screen.getByRole('button', { name: /export to github/i }))
    .toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});
