import { userEvent } from '@vitest/browser/context';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command surface underneath the bridge (the same seam
// bridge.test.tsx mocks) so `draftPrMessage` / `listBranches` / `createPrTask`
// are observable. The bridge gates real calls on `isTauri()`, satisfied by
// stubbing `window.__TAURI_INTERNALS__` in `beforeEach`.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { BranchInfo, CreatePrOptions, Task } from '@/lib/bridge';
import { createPrTask } from '@/lib/bridge';

import { makeTask } from '../../board/_fixtures';
import { CreatePRDialog } from './CreatePRDialog';
import { baseBranchOptions } from './CreatePRDialog.hooks';

const TASK: Task = makeTask({
  id: 't-pr',
  status: 'done',
  title: 'Wire up auth guard',
  description: 'Adds the auth middleware and covers it with tests.',
  branch: 'nc/auth-guard',
  baseBranch: 'main',
  runMode: 'worktree',
  verified: true,
  committed: true,
});

const BRANCHES: BranchInfo[] = [
  { name: 'main', isRemote: false, isCurrent: true, ahead: 0, behind: 0 },
  { name: 'develop', isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
];

/** Route the mocked invoke per command; tests override single commands. */
function stubCommands(overrides: Record<string, (args: unknown) => Promise<unknown>> = {}) {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    const override = overrides[cmd as string];
    if (override !== undefined) return override(args);
    switch (cmd) {
      case 'draft_pr_message':
        return Promise.resolve({ title: 'feat: auth guard', body: 'Drafted summary.' });
      case 'list_branches':
        return Promise.resolve(BRANCHES);
      case 'create_pr_task':
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

/** The production wiring: the dialog's onCreate relays to the bridge command. */
const onCreate = (id: string, opts: CreatePrOptions) => createPrTask(id, opts);

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test('renders and pre-fills title/body from draftPrMessage', async () => {
  stubCommands();
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');
  await expect.element(screen.getByLabelText('Body')).toHaveValue('Drafted summary.');
  // The confirm footer states exactly what leaves the machine.
  await expect
    .element(screen.getByText(/to origin and open a pull request against/))
    .toBeInTheDocument();
});

test('a drafting failure degrades to the task title/description and never blocks', async () => {
  stubCommands({ draft_pr_message: () => Promise.reject(new Error('claude not found')) });
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('Wire up auth guard');
  await expect
    .element(screen.getByLabelText('Body'))
    .toHaveValue('Adds the auth middleware and covers it with tests.');
  await expect.element(screen.getByRole('button', { name: 'Create PR' })).toBeEnabled();
});

test('confirm calls createPrTask with the edited values, base, and draft flag', async () => {
  stubCommands();
  const onClose = vi.fn();
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={onClose} />,
  );
  const title = screen.getByLabelText('Title');
  await expect.element(title).toHaveValue('feat: auth guard');

  await title.fill('feat: wire up the auth guard');
  await screen.getByLabelText('Body').fill('Edited body.');
  // The checkbox <input> is visually hidden (sr-only); click the visible label
  // text, which toggles the associated control natively.
  await screen.getByText('Open as a draft pull request').click();
  await screen.getByRole('button', { name: 'Create PR' }).click();

  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('create_pr_task', {
      id: 't-pr',
      base: 'main',
      title: 'feat: wire up the auth guard',
      body: 'Edited body.',
      draft: true,
    }),
  );
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('the governance receipt checkbox (default on) appends the for_github receipt to the body', async () => {
  const RECEIPT =
    '### 🌙 Nightcore — Trust report: Wire up auth guard\n\n_Posted from Nightcore._';
  stubCommands({ trust_report_markdown: () => Promise.resolve(RECEIPT) });
  const created: CreatePrOptions[] = [];
  const capture = (_id: string, opts: CreatePrOptions) => {
    created.push(opts);
    return Promise.resolve();
  };
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={capture} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Body')).toHaveValue('Drafted summary.');

  // The checkbox defaults ON — submit renders the for_github receipt and appends
  // it to the drafted body before handing it to the create.
  await screen.getByRole('button', { name: 'Create PR' }).click();
  await vi.waitFor(() => expect(created.length).toBe(1));
  expect(invoke).toHaveBeenCalledWith('trust_report_markdown', {
    taskId: 't-pr',
    forGithub: true,
  });
  expect(created[0]?.body).toBe(`Drafted summary.\n\n${RECEIPT}`);
});

test('unchecking the governance receipt leaves the body untouched and renders no receipt', async () => {
  stubCommands({ trust_report_markdown: () => Promise.resolve('SHOULD-NOT-APPEAR') });
  const created: CreatePrOptions[] = [];
  const capture = (_id: string, opts: CreatePrOptions) => {
    created.push(opts);
    return Promise.resolve();
  };
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={capture} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Body')).toHaveValue('Drafted summary.');

  // Toggle the receipt off (click the visible sr-only label text), then submit.
  await screen.getByText('Include governance receipt').click();
  await screen.getByRole('button', { name: 'Create PR' }).click();
  await vi.waitFor(() => expect(created.length).toBe(1));
  expect(created[0]?.body).toBe('Drafted summary.');
  expect(invoke).not.toHaveBeenCalledWith('trust_report_markdown', expect.anything());
});

test('a receipt render failure never blocks the create — the plain body still goes out', async () => {
  stubCommands({
    trust_report_markdown: () => Promise.reject(new Error('trust report failed')),
  });
  const created: CreatePrOptions[] = [];
  const capture = (_id: string, opts: CreatePrOptions) => {
    created.push(opts);
    return Promise.resolve();
  };
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={capture} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Body')).toHaveValue('Drafted summary.');

  await screen.getByRole('button', { name: 'Create PR' }).click();
  await vi.waitFor(() => expect(created.length).toBe(1));
  // The failed receipt is best-effort: the PR still opens with the plain body.
  expect(created[0]?.body).toBe('Drafted summary.');
});

test('the confirm button single-flights while the create is pending', async () => {
  let resolveCreate: (() => void) | undefined;
  stubCommands({
    create_pr_task: () =>
      new Promise<void>((resolve) => {
        resolveCreate = () => resolve();
      }),
  });
  const onClose = vi.fn();
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={onClose} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');

  await screen.getByRole('button', { name: 'Create PR' }).click();
  await expect.element(screen.getByRole('button', { name: /Creating…/ })).toBeDisabled();
  expect(onClose).not.toHaveBeenCalled();

  resolveCreate!();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('baseBranchOptions offers only gh-valid base names', () => {
  const remote = (name: string): BranchInfo => ({
    name,
    isRemote: true,
    isCurrent: false,
    ahead: 0,
    behind: 0,
  });
  const shaped = baseBranchOptions([
    ...BRANCHES,
    remote('origin/main'), // dupe of a local — dropped
    remote('origin/develop'), // dupe of a local — dropped
    remote('origin/release/2.0'), // remote-only — mapped to its short name
    remote('upstream/release/2.0'), // short-name dupe across remotes — dropped
    remote('origin/hotfix'), // remote-only — mapped
  ]);
  expect(shaped.map((b) => b.name)).toEqual(['main', 'develop', 'release/2.0', 'hotfix']);
  // Nothing gh pr create would reject as --base (AFTER the push already
  // happened) survives the shaping.
  expect(shaped.some((b) => b.name.includes('origin/'))).toBe(false);
});

test('the base picker dropdown never offers remote-tracking spellings', async () => {
  stubCommands({
    list_branches: () =>
      Promise.resolve([
        ...BRANCHES,
        { name: 'origin/main', isRemote: true, isCurrent: false, ahead: 0, behind: 0 },
        { name: 'origin/hotfix', isRemote: true, isCurrent: false, ahead: 0, behind: 0 },
      ]),
  });
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');

  // Open the dropdown (the combobox opens on focus) with an empty filter so
  // every option is listed. Target the combobox role — the open listbox
  // shares the same accessible name.
  const picker = screen.getByRole('combobox', { name: 'Base branch' });
  await picker.fill('');
  await picker.click();
  await expect.element(screen.getByRole('option', { name: /hotfix/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /origin\// }).query()).toBeNull();
});

test('picking a different base re-drafts against it while the fields are pristine', async () => {
  stubCommands({
    draft_pr_message: (args) => {
      const { base } = args as { base: string | null };
      return Promise.resolve(
        base === 'develop'
          ? { title: 'feat: against develop', body: 'Develop summary.' }
          : { title: 'feat: auth guard', body: 'Drafted summary.' },
      );
    },
  });
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');

  // Pick a different base — the pristine draft is re-computed against it (the
  // body states base-relative facts), passing the base through the bridge.
  await screen.getByLabelText('Base branch').fill('develop');
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: against develop');
  await expect.element(screen.getByLabelText('Body')).toHaveValue('Develop summary.');
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('draft_pr_message', { id: 't-pr', base: 'develop' }),
  );
  // The auto-heal leaves no stale-draft note behind.
  expect(screen.getByText(/Draft was written against/).query()).toBeNull();
});

test('a base change after hand-edits shows the stale-draft note and never clobbers', async () => {
  stubCommands();
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={() => {}} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');

  // Hand-edit, then diverge the base: the edits must survive, with the note
  // naming the base the visible draft was actually written against.
  await screen.getByLabelText('Title').fill('feat: my hand-edited title');
  await screen.getByLabelText('Base branch').fill('develop');
  await expect
    .element(screen.getByText('Draft was written against main'))
    .toBeInTheDocument();
  await expect
    .element(screen.getByLabelText('Title'))
    .toHaveValue('feat: my hand-edited title');
  // No re-draft fired against the new base — dirty fields are never clobbered.
  expect(invoke).not.toHaveBeenCalledWith('draft_pr_message', { id: 't-pr', base: 'develop' });
});

test('Escape and backdrop clicks are no-ops while the create is submitting', async () => {
  let resolveCreate: (() => void) | undefined;
  stubCommands({
    create_pr_task: () =>
      new Promise<void>((resolve) => {
        resolveCreate = () => resolve();
      }),
  });
  const onClose = vi.fn();
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={onClose} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');

  await screen.getByRole('button', { name: 'Create PR' }).click();
  await expect.element(screen.getByRole('button', { name: /Creating…/ })).toBeDisabled();

  // Esc mid-submit must NOT dismiss: an unmounted dialog would swallow a later
  // failure. The shared Modal fires onClose unconditionally; the dialog's
  // submitting-aware gate absorbs it.
  await userEvent.keyboard('{Escape}');
  await expect.element(screen.getByLabelText('Title')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  // The backdrop click routes through the same gate.
  const backdrop = document.body.querySelector('[role="presentation"]');
  (backdrop as HTMLElement).click();
  await expect.element(screen.getByLabelText('Title')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();

  // Once the create settles, closing works again.
  resolveCreate!();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('a rejected create shows the inline error and keeps the dialog open', async () => {
  stubCommands({
    create_pr_task: () => Promise.reject(new Error('gh: authentication required')),
  });
  const onClose = vi.fn();
  const screen = render(
    <CreatePRDialog open task={TASK} onCreate={onCreate} onClose={onClose} />,
  );
  await expect.element(screen.getByLabelText('Title')).toHaveValue('feat: auth guard');

  await screen.getByRole('button', { name: 'Create PR' }).click();
  await expect.element(screen.getByText('gh: authentication required')).toBeInTheDocument();
  // Still open (the title field is present) and never closed.
  await expect.element(screen.getByLabelText('Title')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  // A retry is possible: the confirm button is re-enabled.
  await expect.element(screen.getByRole('button', { name: 'Create PR' })).toBeEnabled();
});
