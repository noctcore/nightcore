/** Parsing + labeling for a task's `sourceRef` provenance token — the
 *  `<feature>:<runId>:<itemId>` stamp minted (Rust-side) when a scan item
 *  (Insight finding, Scorecard reading, Harness convention/proposal) is
 *  converted into a board task. The prefix registry lives here once so the
 *  drawer's chip label and the board→scan navigation target can't drift. */

/** A parsed provenance token: which STAGE surface owns the item and what to
 *  preselect there. `view` is the stage destination the shell routes to
 *  (Phase-1 stage regroup); `family` is the originating scan tool, the
 *  discriminator a multiplexing stage shell uses to pick its sub-view — the
 *  Understand stage hosts both Insight (`family: 'insight'` → Find) and
 *  Scorecard (`family: 'scorecard'` → Grade) behind one `understand` view.
 *  `kind` picks the view's selection channel — Harness distinguishes convention
 *  findings from task-shaped proposals; Issue Triage's `validation` is run-level
 *  (the whole validation IS the item). */
export interface ScanTarget {
  /** The stage destination (an `AppView`) the shell navigates to. */
  view: 'understand' | 'harden' | 'enforce' | 'prreview' | 'issuetriage';
  /** The originating scan tool — the discriminator a multiplexing stage shell
   *  (Understand) reads to route the target to its owning sub-view. */
  family: 'insight' | 'scorecard' | 'harness' | 'pr-review' | 'issue-triage';
  kind: 'finding' | 'reading' | 'proposal' | 'validation';
  runId: string;
  itemId: string;
}

/** prefix → owning view + selection channel + human chip label (+ whether the
 *  token is run-level, i.e. minted WITHOUT an item segment). A scheme not in this
 *  registry renders no chip and navigates nowhere, so a future/legacy token degrades
 *  silently instead of breaking the drawer. */
const REGISTRY: Record<
  string,
  {
    view: ScanTarget['view'];
    family: ScanTarget['family'];
    kind: ScanTarget['kind'];
    label: string;
    /** True for a `<scheme>:<runId>` token with no item segment (the run IS the
     *  item). Item-level schemes require a third `<itemId>` segment. */
    runLevel?: boolean;
  }
> = {
  // Phase-1 stage regroup (view rethink PR 3): the sourceRef PREFIX the Rust
  // convert mints is FROZEN (paired with the six mint sites — do not rename), but
  // the `view` it resolves to is retargeted to the STAGE that now hosts it. The
  // `family` keeps the originating tool so a multiplexing stage (Understand) can
  // route the target to its owning sub-view. Reads stay a single lookup through
  // this registry — no `.nightcore/tasks/*.json` rewrite, no migration.
  // Insight + Scorecard both land on the Understand stage; `family` splits them.
  insight: { view: 'understand', family: 'insight', kind: 'finding', label: 'Insight finding' },
  scorecard: {
    view: 'understand',
    family: 'scorecard',
    kind: 'reading',
    label: 'Scorecard reading',
  },
  // Harness convention findings land on Enforce; task-shaped proposals on Harden.
  // Both carry `family: 'harness'` — the destination split is by prefix→view here,
  // and the section within HarnessView is picked by `kind` (finding vs proposal).
  harness: { view: 'enforce', family: 'harness', kind: 'finding', label: 'Harness convention' },
  'harness-proposal': {
    view: 'harden',
    family: 'harness',
    kind: 'proposal',
    label: 'Harness proposal',
  },
  // Keyed by the sourceRef PREFIX the Rust convert mints (`pr-review:<n>:<id>`),
  // not the AppView slug — the parser resolves by the token's first segment.
  // PR Review keeps its own destination (a Verify-stage child), unchanged.
  'pr-review': { view: 'prreview', family: 'pr-review', kind: 'finding', label: 'PR Review finding' },
  // SPELLING SPLIT (learned from `pr-review` vs `prreview`): the sourceRef KEY is
  // hyphenated (`issue-triage:<runId>` — what the Rust convert mints, see
  // `convert_issue_validation_to_task`), while the AppView it navigates to is NOT
  // (`issuetriage`). Keep both spellings consistent everywhere. Issue Triage keeps
  // its own destination (an Intake-stage child). This scheme is run-level: the
  // convert mints a 2-segment token (no itemId) because a validation carries a
  // single verdict, so the whole run IS the item.
  'issue-triage': {
    view: 'issuetriage',
    family: 'issue-triage',
    kind: 'validation',
    label: 'Issue validation',
    runLevel: true,
  },
};

/** Resolve a `sourceRef` to its human provenance label, or `null` for an
 *  unknown/absent token. */
export function sourceRefLabel(sourceRef: string | null): string | null {
  if (sourceRef === null) return null;
  return REGISTRY[sourceRef.split(':')[0] ?? '']?.label ?? null;
}

/** Parse a `sourceRef` into a navigable scan target, or `null` when the token
 *  is malformed or its scheme is unknown. Item ids may themselves contain
 *  colons; only the first two separators are structural. A run-level scheme
 *  (e.g. `issue-triage`) mints a 2-segment `<scheme>:<runId>` token — its
 *  `itemId` is empty (the run IS the item); every other scheme requires an
 *  `<itemId>` third segment. */
export function parseSourceRef(sourceRef: string): ScanTarget | null {
  const [prefix = '', runId = '', ...rest] = sourceRef.split(':');
  const itemId = rest.join(':');
  const entry = REGISTRY[prefix];
  if (entry === undefined || runId === '') return null;
  if (!entry.runLevel && itemId === '') return null;
  return { view: entry.view, family: entry.family, kind: entry.kind, runId, itemId };
}
