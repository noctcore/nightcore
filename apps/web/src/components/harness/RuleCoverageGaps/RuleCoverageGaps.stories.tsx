import type { Meta, StoryObj } from '@storybook/react-vite';

import type { ConventionDriftVM, RuleCoverageGapVM } from '../harness.types';
import type { ArmedDriftView } from '../harness-drift.hooks';
import { RuleCoverageGaps } from './RuleCoverageGaps';

/** A measured EnforceRun with no carried-forward predecessor (the first run). */
function measured(records: ConventionDriftVM[]): ArmedDriftView {
  return { drift: records, deep: false, previous: null };
}

function gap(over: Partial<RuleCoverageGapVM> = {}): RuleCoverageGapVM {
  const fp = over.conventionFingerprint ?? over.fingerprint ?? 'fp';
  return {
    id: `coverage-${fp}`,
    conventionFingerprint: fp,
    category: 'imports-boundaries',
    title: 'A convention',
    status: 'unenforced',
    enforcedBy: [],
    documentedIn: [],
    suggestedArtifactKind: null,
    ...over,
    fingerprint: fp,
  };
}

function drift(over: Partial<ConventionDriftVM> = {}): ConventionDriftVM {
  const fp = over.conventionFingerprint ?? over.fingerprint ?? 'fp';
  return {
    id: `drift-${fp}`,
    conventionFingerprint: fp,
    category: 'imports-boundaries',
    title: 'A convention',
    status: 'clean',
    method: 'lint-meta: a-rule',
    sitesMatched: 0,
    sitesChecked: 0,
    checkName: 'a-rule',
    errorReason: null,
    ...over,
    fingerprint: fp,
  };
}

const MIXED_GAPS: RuleCoverageGapVM[] = [
  gap({
    conventionFingerprint: 'fp1',
    title: 'Components follow strict folder-per-component',
    status: 'enforced',
    enforcedBy: ['nightcore/component-folder-structure'],
  }),
  gap({
    conventionFingerprint: 'fp2',
    title: 'Error handling goes through the shared taxonomy',
    status: 'documented-only',
    documentedIn: ['Errors go through the taxonomy.'],
  }),
  gap({
    conventionFingerprint: 'fp3',
    title: 'No reaching past a feature public barrel',
    status: 'unenforced',
    suggestedArtifactKind: 'eslint-rule',
  }),
];

const meta = {
  title: 'Harness/RuleCoverageGaps',
  component: RuleCoverageGaps,
  args: {
    gaps: MIXED_GAPS,
    // fp1 drifted (method + counts), fp3 clean (method + counts); fp2 has no armed
    // check → the UI derives `uncheckable`.
    drift: measured([
      drift({
        conventionFingerprint: 'fp1',
        title: 'Components follow strict folder-per-component',
        status: 'drifted',
        method: 'lint-meta: folder-per-component',
        sitesMatched: 3,
        sitesChecked: 42,
        checkName: 'folder-per-component',
      }),
      drift({
        conventionFingerprint: 'fp3',
        title: 'No reaching past a feature public barrel',
        status: 'clean',
        method: 'shell: rg -c cross-feature-import',
        sitesMatched: 0,
        sitesChecked: 18,
        checkName: 'no-cross-feature-imports',
      }),
    ]),
  },
} satisfies Meta<typeof RuleCoverageGaps>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Coverage + measured drift joined by fingerprint: a drifted rule, a clean rule
 *  (both WITH method + counts), and a documented-only convention derived
 *  `uncheckable` (no armed check). */
export const MixedCoverage: Story = {};

/** Every convention has an enforcing rule; no EnforceRun yet → drift not measured. */
export const AllEnforced: Story = {
  args: {
    gaps: [
      gap({
        conventionFingerprint: 'e1',
        title: 'Folder-per-component',
        status: 'enforced',
        enforcedBy: ['nightcore/component-folder-structure'],
      }),
    ],
    drift: measured([]),
  },
};

/** Coverage present but NO EnforceRun has run — the honest "not measured yet" state
 *  (no drift chips, no fake "clean"). */
export const DriftNotMeasured: Story = {
  args: { gaps: MIXED_GAPS, drift: measured([]) },
};

/** An armed check that ran but whose output could not be parsed into counts →
 *  `errored` with its reason (never silently "clean"). */
export const DriftErrored: Story = {
  args: {
    gaps: [
      gap({
        conventionFingerprint: 'x1',
        title: 'Public API stays additive',
        status: 'enforced',
        enforcedBy: ['api-extractor'],
      }),
    ],
    drift: measured([
      drift({
        conventionFingerprint: 'x1',
        title: 'Public API stays additive',
        status: 'errored',
        method: 'shell: api-extractor run',
        sitesMatched: 0,
        sitesChecked: 0,
        errorReason: 'api-extractor exited 2 (config not found)',
      }),
    ]),
  },
};

/** A run with no coverage renders nothing. */
export const Empty: Story = { args: { gaps: [], drift: measured([]) } };

/** The MEASURED drift of the story's default run, reused as a carry-forward baseline. */
const CURRENT_DRIFT: ConventionDriftVM[] = [
  drift({
    conventionFingerprint: 'fp1',
    status: 'drifted',
    method: 'lint-meta: folder-per-component',
    sitesMatched: 3,
    sitesChecked: 42,
  }),
  drift({
    conventionFingerprint: 'fp3',
    status: 'clean',
    method: 'shell: rg -c cross-feature-import',
    sitesMatched: 0,
    sitesChecked: 18,
  }),
];

/** Carry-forward (#279) with a COMPARABLE predecessor: the same conventions measured
 *  by the same methods, so the trend is real — fp1 improved 7 → 3, fp3 resolved. */
export const DriftTrend: Story = {
  args: {
    gaps: MIXED_GAPS,
    drift: {
      drift: CURRENT_DRIFT,
      deep: false,
      previous: {
        deep: false,
        ranAt: Date.now() - 26 * 60 * 60 * 1000,
        drift: [
          drift({
            conventionFingerprint: 'fp1',
            status: 'drifted',
            method: 'lint-meta: folder-per-component',
            sitesMatched: 7,
            sitesChecked: 42,
          }),
          drift({
            conventionFingerprint: 'fp3',
            status: 'drifted',
            method: 'shell: rg -c cross-feature-import',
            sitesMatched: 2,
            sitesChecked: 18,
          }),
        ],
      },
    },
  },
};

/** Carry-forward with an INCOMPARABLE predecessor: a check was armed since, so the two
 *  runs measured different ground. The panel says so instead of inventing a trend. */
export const DriftTrendGroundChanged: Story = {
  args: {
    gaps: MIXED_GAPS,
    drift: {
      drift: CURRENT_DRIFT,
      deep: false,
      previous: {
        deep: false,
        ranAt: Date.now() - 3 * 60 * 60 * 1000,
        drift: [
          drift({
            conventionFingerprint: 'fp1',
            status: 'drifted',
            method: 'lint-meta: folder-per-component',
            sitesMatched: 7,
            sitesChecked: 42,
          }),
        ],
      },
    },
  },
};
