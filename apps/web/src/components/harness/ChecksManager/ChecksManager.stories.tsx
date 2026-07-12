import type { Meta, StoryObj } from '@storybook/react-vite';

import type { ArmedCheck } from '@/lib/bridge';

import { ChecksManager } from './ChecksManager';
import type { ChecksManagerVM } from './ChecksManager.types';

const noop = () => {};

function makeVm(over: Partial<ChecksManagerVM> = {}): ChecksManagerVM {
  return {
    loading: false,
    loadError: null,
    checks: [],
    lastRun: null,
    actionError: null,
    pendingName: null,
    run: { running: false, error: null, start: noop },
    toggle: noop,
    edit: {
      draft: null,
      saving: false,
      error: null,
      start: noop,
      change: noop,
      cancel: noop,
      save: noop,
    },
    remove: {
      target: null,
      busy: false,
      request: noop,
      cancel: noop,
      confirm: noop,
    },
    validate: {
      results: {},
      errors: {},
      pendingName: null,
      start: noop,
    },
    ...over,
  };
}

const LINT: ArmedCheck = {
  name: 'folder-per-component',
  kind: 'lint-plugin',
  command: 'npx eslint .',
  enabled: true,
  timeoutMs: 120000,
  lastResult: { status: 'passed', exitCode: 0, durationMs: 3400 },
};

const ARCH: ArmedCheck = {
  name: 'architecture-boundaries',
  kind: 'dependency-cruiser',
  command: 'npx depcruise src',
  enabled: false,
};

const COVERAGE: ArmedCheck = {
  name: 'coverage-threshold',
  kind: 'coverage-threshold',
  command: 'npx vitest run --coverage',
  enabled: true,
  lastResult: {
    status: 'failed',
    exitCode: 1,
    durationMs: 8200,
    output: 'ERROR: Coverage for lines (78%) does not meet threshold (80%)',
  },
};

const meta = {
  title: 'Harness/ChecksManager',
  component: ChecksManager,
  args: {
    vm: makeVm({
      checks: [LINT, ARCH],
      lastRun: { passed: true, ranAt: Date.now() - 5 * 60 * 1000 },
    }),
  },
} satisfies Meta<typeof ChecksManager>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A passing armed set with one disabled check + a last-run banner. */
export const Populated: Story = {};

/** A failing check shows its exit code + captured output. */
export const WithFailure: Story = {
  args: {
    vm: makeVm({
      checks: [LINT, COVERAGE],
      lastRun: { passed: false, failedCheck: 'coverage-threshold', ranAt: Date.now() - 30 * 1000 },
    }),
  },
};

/** No checks armed yet — the guidance empty state. */
export const Empty: Story = { args: { vm: makeVm() } };

/** A lint-plugin check whose rule was validated: the structural-probe verdict shows
 *  inline under the row (the "real rule, not a placebo" confirmation). */
export const Validated: Story = {
  args: {
    vm: makeVm({
      checks: [LINT],
      validate: {
        results: {
          'folder-per-component': {
            ruleId: 'folder-per-component',
            outcome: 'probed',
            ruleLoaded: true,
            eslintVersion: '9.11.0',
            validPassed: 0,
            validTotal: 0,
            invalidPassed: 0,
            invalidTotal: 0,
            cases: [],
          },
        },
        errors: {},
        pendingName: null,
        start: noop,
      },
    }),
  },
};

/** A lint-plugin check whose rule could not be loaded — the soft `error` verdict with
 *  the runner's diagnostic message. */
export const ValidationFailed: Story = {
  args: {
    vm: makeVm({
      checks: [LINT],
      validate: {
        results: {
          'folder-per-component': {
            ruleId: 'folder-per-component',
            outcome: 'error',
            ruleLoaded: false,
            validPassed: 0,
            validTotal: 0,
            invalidPassed: 0,
            invalidTotal: 0,
            cases: [],
            error: "could not load rule 'folder-per-component' from '': module not found",
          },
        },
        errors: {},
        pendingName: null,
        start: noop,
      },
    }),
  },
};

/** A check open in the inline editor. */
export const Editing: Story = {
  args: {
    vm: makeVm({
      checks: [LINT],
      edit: {
        draft: {
          originalName: 'folder-per-component',
          name: 'folder-per-component',
          kind: 'lint-plugin',
          command: 'npx eslint .',
          timeoutMs: '120000',
          enabled: true,
        },
        saving: false,
        error: null,
        start: noop,
        change: noop,
        cancel: noop,
        save: noop,
      },
    }),
  },
};
