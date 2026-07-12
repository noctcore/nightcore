import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri `invoke` seam (the prreview-runs.hooks.test.tsx pattern): the hook
// loads the armed checks on mount and validates a rule on demand, both through
// `invoke`. Controlling it per-command lets us drive the validate action in isolation.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { ArmedCheck, ArmedChecksState, RuleValidationResult } from '@/lib/bridge';

import { useChecksManager } from './ChecksManager.hooks';
import type { ChecksManagerVM } from './ChecksManager.types';

const LINT_CHECK: ArmedCheck = {
  name: 'folder-per-component',
  kind: 'lint-plugin',
  command: 'npx eslint .',
  enabled: true,
  configPath: 'packages/eslint-plugin/index.ts',
};

const STATE: ArmedChecksState = { checks: [LINT_CHECK], drift: [] };

function validationResult(over: Partial<RuleValidationResult> = {}): RuleValidationResult {
  return {
    ruleId: 'folder-per-component',
    outcome: 'probed',
    ruleLoaded: true,
    validPassed: 0,
    validTotal: 0,
    invalidPassed: 0,
    invalidTotal: 0,
    cases: [],
    ...over,
  };
}

/** Flip Tauri detection on so the bridge wrappers reach the mocked `invoke` instead
 *  of returning their browser-preview fallbacks. */
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function Harness({ sink }: { sink: (vm: ChecksManagerVM) => void }) {
  const vm = useChecksManager();
  useEffect(() => {
    sink(vm);
  });
  return null;
}

async function mountHook(): Promise<() => ChecksManagerVM> {
  let vm: ChecksManagerVM | undefined;
  render(<Harness sink={(v) => (vm = v)} />);
  await vi.waitFor(() => {
    expect(vm).toBeDefined();
    expect(vm!.checks).toHaveLength(1);
  });
  return () => vm!;
}

test('validate success: the RuleTester verdict lands on the check, keyed by name', async () => {
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_armed_checks') return Promise.resolve(STATE);
    if (cmd === 'validate_plugin_rule') return Promise.resolve(validationResult());
    return Promise.resolve(undefined);
  });
  const vm = await mountHook();

  vm().validate.start(LINT_CHECK);

  await vi.waitFor(() =>
    expect(vm().validate.results['folder-per-component']?.outcome).toBe('probed'),
  );
  // The command was invoked with the check's name as ruleId + its configPath as rulePath.
  const call = invoke.mock.calls.find((c) => c[0] === 'validate_plugin_rule');
  expect(call?.[1]).toMatchObject({
    ruleId: 'folder-per-component',
    rulePath: 'packages/eslint-plugin/index.ts',
  });
  // A clean run leaves no per-check transport error and clears the pending marker.
  expect(vm().validate.errors['folder-per-component']).toBeUndefined();
  expect(vm().validate.pendingName).toBeNull();
});

test('validate soft failure: an error-outcome verdict is surfaced as a result (not an exception)', async () => {
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_armed_checks') return Promise.resolve(STATE);
    if (cmd === 'validate_plugin_rule') {
      return Promise.resolve(
        validationResult({
          outcome: 'error',
          ruleLoaded: false,
          error: "could not load rule 'folder-per-component'",
        }),
      );
    }
    return Promise.resolve(undefined);
  });
  const vm = await mountHook();

  vm().validate.start(LINT_CHECK);

  await vi.waitFor(() =>
    expect(vm().validate.results['folder-per-component']?.outcome).toBe('error'),
  );
  expect(vm().validate.results['folder-per-component']?.error).toBe(
    "could not load rule 'folder-per-component'",
  );
  // A soft error is a well-formed result, not a transport error.
  expect(vm().validate.errors['folder-per-component']).toBeUndefined();
});

test('validate transport rejection: the failure message is recorded per check', async () => {
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_armed_checks') return Promise.resolve(STATE);
    if (cmd === 'validate_plugin_rule') {
      return Promise.reject(new Error('validate-rule query failed'));
    }
    return Promise.resolve(undefined);
  });
  const vm = await mountHook();

  vm().validate.start(LINT_CHECK);

  await vi.waitFor(() =>
    expect(vm().validate.errors['folder-per-component']).toBe('validate-rule query failed'),
  );
  expect(vm().validate.results['folder-per-component']).toBeUndefined();
  expect(vm().validate.pendingName).toBeNull();
});
