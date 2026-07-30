/** Bridge commands — the project trust dashboard (issue #399): the repo-scoped,
 *  computed-on-demand governance summary and its shields-compatible badge export.
 *
 *  `workflow::trust` answers "this merge"; these answer "this repo, this month".
 *  Every value is aggregated per request from the task store, the flight-recorder
 *  ledgers and the append-only governance journal — nothing here is cached on
 *  either side of the bridge, so the dashboard can never drift from the journal.
 *  Outside the Tauri webview (browser preview / stories) they resolve deterministic
 *  mocks so the card renders instead of rejecting. */
import { invoke } from '@tauri-apps/api/core';

import { isTauri, tauriInvoke } from '../internal';
import type { ProjectTrustSummary } from '../types';

/** The browser-preview summary: a project with real history, so the card's stat
 *  grid, badge and journal feed all render in Storybook. Kept local (the shared
 *  `mocks.ts` is at its size cap), mirroring `./policy`'s activity mock. */
const MOCK_PROJECT_TRUST: ProjectTrustSummary = {
  generatedAt: '2026-07-29T14:20:00Z',
  merges: { tasks: 46, merged: 31, verified: 29, verifiedMerges: 28 },
  gauntlet: { runs: 34, passed: 32, passRate: 32 / 34 },
  guardrails: {
    toolsEvaluated: 4182,
    allowed: 4106,
    asked: 41,
    denied: 35,
    policyDenials: 22,
    sessions: 46,
    topRules: [
      { ruleId: 'harness-protected-path', count: 14, source: 'policy' },
      { ruleId: 'harness-bash-deny', count: 8, source: 'policy' },
      { ruleId: 'pipe-to-shell', count: 7, source: 'builtin' },
      { ruleId: 'workspace-confinement', count: 6, source: 'builtin' },
    ],
  },
  spend: { costUsd: 41.87, tasksWithCost: 39 },
  journal: {
    events: 12,
    quarantines: 2,
    policySaves: 5,
    arms: 3,
    disarms: 1,
    ratchets: 1,
    other: 0,
    corruptLines: 0,
    lastEventAt: '2026-07-29T13:58:11Z',
    recent: [
      {
        id: '11',
        ts: '2026-07-29T13:58:11Z',
        kind: 'quarantine',
        summary: 'quarantined 1 path(s) from agent reads',
        detail: ['docs/vendor/CHANGELOG.md'],
      },
      {
        id: '10',
        ts: '2026-07-29T13:57:40Z',
        kind: 'policy-save',
        summary:
          'policy saved — armed, 4 protected path(s), 3 bash denial(s), 2 denied read(s), tools 1/2/0 (deny/ask/allow)',
        detail: [],
      },
      {
        id: '9',
        ts: '2026-07-28T09:14:02Z',
        kind: 'arm',
        summary: 'armed check `structure-lock` (lint-meta)',
        detail: ['structure-lock'],
      },
      {
        id: '8',
        ts: '2026-07-27T16:02:55Z',
        kind: 'ratchet',
        summary: 'ratchet baseline snapshotted — 41 any, 5 @ts-ignore, 3 eslint-disable',
        detail: [],
      },
    ],
  },
  badge: {
    schemaVersion: 1,
    label: 'governance',
    message: '28 verified merges · 94% gauntlet · 35 denials',
    color: 'green',
  },
};

/** The active project's governance posture: verified merges, gauntlet pass rate,
 *  guardrail denials with rule attribution, spend, and the governance journal
 *  rolled up with a recent feed. Computed server-side per call. */
export async function projectTrustSummary(): Promise<ProjectTrustSummary> {
  return tauriInvoke<ProjectTrustSummary>('project_trust_summary', {}, MOCK_PROJECT_TRUST);
}

/** The shields.io endpoint payload for the active project as pretty JSON — the
 *  bytes a repo publishes so `https://img.shields.io/endpoint?url=…` renders its
 *  governance posture. Derived from the same summary above. */
export async function governanceBadgeJson(): Promise<string> {
  return tauriInvoke<string>(
    'governance_badge_json',
    {},
    JSON.stringify(MOCK_PROJECT_TRUST.badge, null, 2),
  );
}

/** The outcome of a badge export: whether the user completed the save, and where. */
export interface GovernanceBadgeExport {
  /** True once the JSON was written to `path`; false when the user cancelled the
   *  native save dialog or the call ran outside Tauri. */
  saved: boolean;
  /** The absolute path written to, or `null` when nothing was saved. */
  path: string | null;
}

/** Export the badge to a user-chosen `*.json` file: open the native save dialog,
 *  then have Rust re-compute and atomically write the payload (`write_governance_badge`).
 *  Keeping the write Rust-side preserves the ONE serializer while the path choice
 *  stays a native dialog; the backend refuses any destination inside a
 *  `.nightcore/` directory, so a badge can never land on the journal it reports on.
 *  Resolves `{ saved: false }` when the user cancels or outside Tauri. */
export async function exportGovernanceBadge(
  suggestedName: string = 'governance-badge',
): Promise<GovernanceBadgeExport> {
  if (!isTauri()) return { saved: false, path: null };
  // Dynamic import inside the isTauri() branch (the bridge idiom) — a static
  // `import { save }` at module scope breaks sibling tests whose
  // `vi.mock('@tauri-apps/plugin-dialog')` factory predates this export.
  const { save } = await import('@tauri-apps/plugin-dialog');
  const dest = await save({
    title: 'Export governance badge',
    defaultPath: `${suggestedName}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (dest === null) return { saved: false, path: null };
  await invoke<void>('write_governance_badge', { destPath: dest });
  return { saved: true, path: dest };
}
