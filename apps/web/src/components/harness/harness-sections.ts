/** Harness destination vocabulary: which body sections a given destination shows.
 *
 *  The Harden / Enforce split (Phase-1 view rethink, PR 2) is a pure VIEW FILTER
 *  over the ONE harness run/store — no engine, run, or store is split. `mode`
 *  selects which section tabs render and whether the RepoProfile banner shows:
 *    - `harden`  = the PROPOSE half (Proposals + Artifacts + profile + apply flow)
 *    - `enforce` = the ENFORCE half (Conventions/gaps + Policy + gauntlet-arm)
 *    - `undefined` = the unified route (all sections — the pre-split behavior)
 *
 *  Keeping this derivation pure (no React) is what lets it be unit-tested without
 *  a live run — the tab bar only renders in the RESULTS phase.  See
 *  docs/research/2026-07-10-phase1-view-rethink-spec.md § 4. */

/** Which body section is showing: the convention grid, the task-shaped proposals,
 *  the file-level artifacts, the armed-checks manager, or the runtime-policy editor
 *  + injection scan. */
export type HarnessSection = 'conventions' | 'proposals' | 'artifacts' | 'checks' | 'policy';

/** The harness destination: the PROPOSE half, the ENFORCE half, or (undefined) the
 *  unified route that shows every section. */
export type HarnessMode = 'harden' | 'enforce';

/** One rendered section tab: which body it selects, its label, and its badge count. */
export interface HarnessSectionTab {
  key: HarnessSection;
  label: string;
  count: number;
}

/** Per-section badge counts. Policy edits the project manifest directly, so it has
 *  no per-run count and is omitted here. */
export interface HarnessSectionCounts {
  conventions: number;
  proposals: number;
  artifacts: number;
}

/** Ordered sections per destination. `all` is the unified route (pre-split). The
 *  armed-checks manager rides the ENFORCE half (alongside conventions + policy). */
const SECTIONS_BY_MODE = {
  all: ['conventions', 'proposals', 'artifacts', 'checks', 'policy'],
  harden: ['proposals', 'artifacts'],
  enforce: ['conventions', 'checks', 'policy'],
} as const satisfies Record<'all' | HarnessMode, readonly HarnessSection[]>;

/** The section a destination opens on (its first tab). Held as an explicit map
 *  rather than `SECTIONS_BY_MODE[…][0]` so it types cleanly under
 *  `noUncheckedIndexedAccess`. */
const DEFAULT_SECTION_BY_MODE: Record<'all' | HarnessMode, HarnessSection> = {
  all: 'conventions',
  harden: 'proposals',
  enforce: 'conventions',
};

const SECTION_LABELS: Record<HarnessSection, string> = {
  conventions: 'Conventions',
  proposals: 'Proposals',
  artifacts: 'Artifacts',
  checks: 'Checks',
  policy: 'Policy',
};

/** The default (opening) section for a destination. */
export function defaultSectionForMode(mode: HarnessMode | undefined): HarnessSection {
  return DEFAULT_SECTION_BY_MODE[mode ?? 'all'];
}

/** The RepoProfile banner rides the PROPOSE half — it is hidden in the ENFORCE
 *  destination and shown everywhere else (harden + the unified route). */
export function showProfileBannerForMode(mode: HarnessMode | undefined): boolean {
  return (mode ?? 'all') !== 'enforce';
}

/** The ordered, mode-filtered section tabs with their live badge counts. */
export function sectionTabsForMode(
  mode: HarnessMode | undefined,
  counts: HarnessSectionCounts,
): HarnessSectionTab[] {
  const countFor: Record<HarnessSection, number> = {
    conventions: counts.conventions,
    proposals: counts.proposals,
    artifacts: counts.artifacts,
    // Checks + Policy edit the project manifest directly — no per-run count.
    checks: 0,
    policy: 0,
  };
  return SECTIONS_BY_MODE[mode ?? 'all'].map((key) => ({
    key,
    label: SECTION_LABELS[key],
    count: countFor[key],
  }));
}
