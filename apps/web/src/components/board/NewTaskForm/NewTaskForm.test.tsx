import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ProviderCapabilities } from '@nightcore/contracts';
import { MAX_IMAGES_PER_TASK } from '@/lib/attachments';
import type { HarnessPolicyFile } from '@/lib/bridge';
import { governanceWarningFor, harnessPolicyHasRules } from '@/lib/harness-governance';
import {
  cacheProviderCapabilities,
  CLAUDE_CAPABILITIES,
} from '@/lib/provider-capabilities';

import { planFirstDefault, useNewTaskForm } from './NewTaskForm.hooks';
import * as stories from './NewTaskForm.stories';
import type { NewTaskFormProps } from './NewTaskForm.types';

const { Default } = composeStories(stories);

/** A Codex-like descriptor — derived from the Claude default via spread (a test
 *  fixture, not a hand-copied source of truth; the real Codex matrix now arrives over
 *  the wire). Seeded into the capabilities cache so the full-render tests below can
 *  pick Codex and see it resolve to the ungoverned/unenforced matrix synchronously,
 *  the way `useProviderCapabilities` primes it inside Tauri. */
const CODEX_CAPS: ProviderCapabilities = {
  ...CLAUDE_CAPABILITIES,
  id: 'codex',
  label: 'Codex',
  supportsHarnessPolicy: false,
  supportsLedger: false,
  supportsHooks: false,
  supportsMaxTurns: false,
  supportsMaxBudget: false,
};
cacheProviderCapabilities(CODEX_CAPS);

test('planFirstDefault seeds plan-first only for a Build task on a hooks-capable provider', () => {
  // The interactive default-on: Build + gate on + a plan-capable provider.
  expect(planFirstDefault('build', true, true)).toBe(true);
  // Fix 3 (#147): a hookless provider (Codex) is NEVER plan-gated by the default —
  // a plan-mode run there surfaces no plan and would silently no-op.
  expect(planFirstDefault('build', true, false)).toBe(false);
  // Non-Build kinds and a disabled gate default off regardless of the provider.
  expect(planFirstDefault('research', true, true)).toBe(false);
  expect(planFirstDefault('build', false, true)).toBe(false);
});

const EMPTY_POLICY_FILE: HarnessPolicyFile = {
  enabled: true,
  protectedPaths: [],
  denyBashPatterns: [],
  denyReadPaths: [],
  disallowedTools: [],
  allowTools: [],
  askTools: [],
  allowExecSinks: [],
  diffBudget: null,
  manifestExists: true,
};

test('harnessPolicyHasRules (#296): false for an all-empty policy, true when any field has a rule', () => {
  expect(harnessPolicyHasRules(EMPTY_POLICY_FILE)).toBe(false);
  expect(harnessPolicyHasRules({ ...EMPTY_POLICY_FILE, protectedPaths: ['bun.lock'] })).toBe(true);
  expect(
    harnessPolicyHasRules({ ...EMPTY_POLICY_FILE, denyBashPatterns: ['--no-verify'] }),
  ).toBe(true);
});

test('harnessPolicyHasRules (#308): true for a policy armed exclusively via allowExecSinks', () => {
  // The web governance banner's fail-safe gap: a manifest armed ONLY through the
  // exec-sink downgrade list (hand-edited; not exposed by the policy editor) must
  // still trip the "armed" signal so the pre-Create banner matches the engine's
  // `harnessPolicyHasRules` (`packages/engine/src/providers/agent-provider.ts`),
  // which checks this exact 7th array.
  expect(
    harnessPolicyHasRules({ ...EMPTY_POLICY_FILE, allowExecSinks: ['.github/workflows/**'] }),
  ).toBe(true);
});

test('governanceWarningFor (#296): only warns when the policy is armed AND the provider lacks governance', () => {
  // No warning: policy not armed, capabilities unresolved, or a governed provider.
  expect(governanceWarningFor(false, CODEX_CAPS)).toBeNull();
  expect(governanceWarningFor(true, null)).toBeNull();
  expect(governanceWarningFor(true, CLAUDE_CAPABILITIES)).toBeNull();
  // Warns: policy armed AND the resolved provider can't enforce it. Never mentions
  // the audit ledger — the ledger path is unconditional per project, never an
  // independent trigger (see the engine's `assertGovernanceInvariant` docblock).
  const warning = governanceWarningFor(true, CODEX_CAPS);
  expect(warning).not.toBeNull();
  expect(warning).toContain('Codex');
  expect(warning).toContain('Harness governance policy');
  expect(warning).not.toContain('audit ledger');
});

test('gates create on a non-empty title, then fires onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  const create = screen.getByRole('button', { name: /create task/i });
  await expect.element(create).toBeDisabled();

  await userEvent.type(screen.getByLabelText('Title').element(), 'Add a panel');
  await expect.element(create).toBeEnabled();
  await create.click();

  expect(onCreate).toHaveBeenCalledWith('Add a panel', '', 'build', 'main', {
    permissionMode: null,
    // Build + the default-on plan gate ⇒ the "Plan first" toggle seeds true.
    planFirst: true,
    model: null,
    effort: null,
    maxTurns: null,
    // A blank budget field inherits (no override on the wire).
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});

test('threads an explicit max-turns ceiling through onCreate', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText('Title').element(), 'Bounded run');
  await userEvent.type(screen.getByLabelText('Max turns').element(), '40');
  await screen.getByRole('button', { name: /create task/i }).click();

  expect(onCreate).toHaveBeenCalledWith('Bounded run', '', 'build', 'main', {
    permissionMode: null,
    planFirst: true,
    model: null,
    effort: null,
    maxTurns: 40,
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});

test('a $0 max-budget inherits — 0 is not a valid ceiling (#240)', async () => {
  const onCreate = vi.fn(async () => {});
  const screen = render(<Default onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText('Title').element(), 'Zero budget');
  // The wire contract is `maxBudgetUsd: positive().optional()` — a $0 ceiling is
  // unrunnable, so "0" must inherit exactly like the blank field above (not send 0).
  await userEvent.type(screen.getByLabelText('Max budget (USD)').element(), '0');
  await screen.getByRole('button', { name: /create task/i }).click();

  expect(onCreate).toHaveBeenCalledWith('Zero budget', '', 'build', 'main', {
    permissionMode: null,
    planFirst: true,
    model: null,
    effort: null,
    maxTurns: null,
    maxBudgetUsd: null,
    branch: null,
    baseBranch: null,
    attachments: [],
  });
});

test('the governance warning (#296) renders when Codex is picked on a project with an armed policy, and stays absent by default', async () => {
  const screen = render(<Default />);
  // The default story picks no provider ⇒ Claude, which supports governance — no
  // warning even though the mocked project policy (`MOCK_POLICY_FILE`) is armed.
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();

  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /gpt-5 codex/i }).click();

  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(/cannot enforce this project's Harness governance policy/i);
});

// Render `useNewTaskForm` directly so a test can drive `addFiles` twice within one
// render — a drop + a paste that both land before React re-renders. The .tsx dialog
// can't stage that race, but the hook is where the clamp must hold.
type Controller = ReturnType<typeof useNewTaskForm>;

function Harness({ props, sink }: { props: NewTaskFormProps; sink: (c: Controller) => void }) {
  const controller = useNewTaskForm(props);
  useEffect(() => {
    sink(controller);
  });
  return null;
}

async function mountForm(): Promise<() => Controller> {
  let latest: Controller | undefined;
  const props: NewTaskFormProps = {
    open: true,
    planGateDefault: true,
    onCreate: vi.fn(async () => {}),
    onClose: vi.fn(),
  };
  render(<Harness props={props} sink={(c) => (latest = c)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());
  return () => latest!;
}

test('the hook wiring: governanceWarning tracks the picked provider live (#296)', async () => {
  const get = await mountForm();
  // The mocked active-project policy (`MOCK_POLICY_FILE`) is armed; the default
  // (unpicked) provider resolves to Claude, which supports governance.
  await vi.waitFor(() => expect(get().governanceWarning).toBeNull());

  get().setProviderId('codex');
  await vi.waitFor(() => expect(get().governanceWarning).not.toBeNull());
  expect(get().governanceWarning).toContain('Codex');

  get().setProviderId(undefined);
  await vi.waitFor(() => expect(get().governanceWarning).toBeNull());
});

function pngFiles(n: number): File[] {
  return Array.from(
    { length: n },
    (_, i) => new File([new Uint8Array([i + 1])], `img-${i}.png`, { type: 'image/png' }),
  );
}

test('two image adds in one render cannot exceed the per-task cap (#243)', async () => {
  const get = await mountForm();
  await vi.waitFor(() => expect(get().attachments).toHaveLength(0));

  // Both calls read the SAME closure-captured `attachments.length` (0 ⇒ room = MAX),
  // so each accepts a full batch. Without re-clamping in the functional update this
  // overshoots to 2×MAX; the fix caps the committed total at MAX_IMAGES_PER_TASK.
  const controller = get();
  controller.addFiles(pngFiles(MAX_IMAGES_PER_TASK));
  controller.addFiles(pngFiles(MAX_IMAGES_PER_TASK));

  // Let the first read commit, then give the racing second read time to land too.
  await vi.waitFor(() => expect(get().attachments.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(get().attachments).toHaveLength(MAX_IMAGES_PER_TASK);
});
