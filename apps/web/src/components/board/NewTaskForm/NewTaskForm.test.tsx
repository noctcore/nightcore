import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { MAX_IMAGES_PER_TASK } from '@/lib/attachments';

import { planFirstDefault, useNewTaskForm } from './NewTaskForm.hooks';
import * as stories from './NewTaskForm.stories';
import type { NewTaskFormProps } from './NewTaskForm.types';

const { Default } = composeStories(stories);

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
