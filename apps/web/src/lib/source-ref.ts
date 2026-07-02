/** Parsing + labeling for a task's `sourceRef` provenance token — the
 *  `<feature>:<runId>:<itemId>` stamp minted (Rust-side) when a scan item
 *  (Insight finding, Scorecard reading, Harness convention/proposal) is
 *  converted into a board task. The prefix registry lives here once so the
 *  drawer's chip label and the board→scan navigation target can't drift. */

/** A parsed provenance token: which scan surface owns the item and what to
 *  preselect there. `kind` picks the view's selection channel — Harness
 *  distinguishes convention findings from task-shaped proposals. */
export interface ScanTarget {
  view: 'insight' | 'scorecard' | 'harness' | 'prreview';
  kind: 'finding' | 'reading' | 'proposal';
  runId: string;
  itemId: string;
}

/** prefix → owning view + selection channel + human chip label. A scheme not
 *  in this registry renders no chip and navigates nowhere, so a future/legacy
 *  token degrades silently instead of breaking the drawer. */
const REGISTRY: Record<
  string,
  { view: ScanTarget['view']; kind: ScanTarget['kind']; label: string }
> = {
  insight: { view: 'insight', kind: 'finding', label: 'Insight finding' },
  scorecard: { view: 'scorecard', kind: 'reading', label: 'Scorecard reading' },
  harness: { view: 'harness', kind: 'finding', label: 'Harness convention' },
  'harness-proposal': { view: 'harness', kind: 'proposal', label: 'Harness proposal' },
  // Keyed by the sourceRef PREFIX the Rust convert mints (`pr-review:<n>:<id>`),
  // not the AppView slug — the parser resolves by the token's first segment.
  'pr-review': { view: 'prreview', kind: 'finding', label: 'PR Review finding' },
};

/** Resolve a `sourceRef` to its human provenance label, or `null` for an
 *  unknown/absent token. */
export function sourceRefLabel(sourceRef: string | null): string | null {
  if (sourceRef === null) return null;
  return REGISTRY[sourceRef.split(':')[0] ?? '']?.label ?? null;
}

/** Parse a `sourceRef` into a navigable scan target, or `null` when the token
 *  is malformed or its scheme is unknown. Item ids may themselves contain
 *  colons; only the first two separators are structural. */
export function parseSourceRef(sourceRef: string): ScanTarget | null {
  const [prefix = '', runId = '', ...rest] = sourceRef.split(':');
  const itemId = rest.join(':');
  const entry = REGISTRY[prefix];
  if (entry === undefined || runId === '' || itemId === '') return null;
  return { view: entry.view, kind: entry.kind, runId, itemId };
}
