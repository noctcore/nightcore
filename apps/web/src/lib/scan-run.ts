/**
 * Shared scan run-lifecycle helpers, hoisted out of the four structurally-identical
 * scan siblings (Insight / Harness / Scorecard / PR-Review). `apps/web/src/lib/` is
 * the only place the `no-cross-feature-imports` lint permits cross-family sharing,
 * so the pieces that were cloned byte-for-byte across every `*-stream.ts` reducer
 * live here. Mirrors the backend's `scan_lifecycle_commands!` macro over generic
 * `ScanStore`/`ScanRun` (see `packages/engine/src/scans/shared/`).
 */

/**
 * The lifecycle screen a scan view renders. Structurally identical to the shell's
 * `RunPhase` (`@/components/ui`), re-declared here so `lib/` stays below the
 * component layer — a value of this type assigns freely to a `RunPhase` field.
 */
export type ScanViewPhase = 'configure' | 'running' | 'results';

/**
 * Derive the active lifecycle screen from the live stream status and the two view
 * flags. Cloned byte-for-byte across all four scan `*View.hooks.ts`: `isStarting`
 * folds the optimistic-launch IPC gap into RUNNING (the persisted `status` is
 * still the prior run's `completed` until the optimistic running stream lands, so
 * without it a "New run" would flash the previous RESULTS); `reconfiguring` is the
 * explicit "New run" override that returns a completed run to CONFIGURE.
 */
export function deriveRunPhase(
  status: string,
  isStarting: boolean,
  reconfiguring: boolean,
): ScanViewPhase {
  if (status === 'running' || isStarting) return 'running';
  if (reconfiguring || status === 'idle') return 'configure';
  return 'results';
}

/** The token-usage accumulator every scan stream carries (input/output tokens). */
export interface ScanUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Accumulate a per-step usage delta into a running total. A missing delta
 * (`undefined`) leaves the total untouched. This was cloned verbatim in all four
 * `*-stream.ts` reducers — it is the token-accounting primitive the fold uses on
 * every `*-category-completed` / `*-dimension-completed` / `*-lens-completed` event.
 */
export function addUsage(a: ScanUsage, b: ScanUsage | undefined): ScanUsage {
  if (b === undefined) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * The per-step (category / dimension / lens) progress a scan tracks while it runs.
 * Every family re-declares this same four-value union under its own noun
 * (`CategoryProgress` / `DimensionProgress` / `LensProgress`); they are structurally
 * identical and interchange freely with this canonical name.
 */
export type ScanStepProgress = 'pending' | 'running' | 'done' | 'error';

/**
 * Project a persisted run's status string onto the terminal view status. The
 * persisted enum only ever reloads as running / failed / <else = completed>; the
 * `idle` state is live-only, so it never appears here. Cloned verbatim in all four
 * `streamFromRun` projectors.
 */
export function runStatusFromPersisted(
  status: string,
): 'running' | 'failed' | 'completed' {
  return status === 'running'
    ? 'running'
    : status === 'failed'
      ? 'failed'
      : 'completed';
}

/**
 * Seed a fresh step-state map with every requested step `pending`. Used on the
 * `*-started` event to lay out the stepper before any step reports in.
 */
export function seedStepState(
  steps: readonly string[],
): Record<string, ScanStepProgress> {
  return Object.fromEntries(steps.map((s) => [s, 'pending' as ScanStepProgress]));
}

/**
 * Seed a step-state map from a reloaded persisted run: `pending` while the run is
 * still mid-flight (`running === true`), else all `done`. A persisted run carries
 * no per-step completion, so an in-flight reload can only show the stepper as
 * uniformly pending.
 */
export function seedStepStateFromRun(
  steps: readonly string[],
  running: boolean,
): Record<string, ScanStepProgress> {
  return Object.fromEntries(
    steps.map((s) => [s, running ? 'pending' : 'done'] as const),
  );
}

/**
 * Settle every requested step to its terminal state on the `*-completed` event:
 * a step that errored stays `error`, everything else becomes `done`. Cloned
 * verbatim in all four terminal-event folds.
 */
export function settleStepState(
  requested: readonly string[],
  prev: Record<string, ScanStepProgress>,
): Record<string, ScanStepProgress> {
  return Object.fromEntries(
    requested.map((s) => [s, prev[s] === 'error' ? 'error' : 'done'] as const),
  );
}

/** The repo-relative code anchor a scan view renders: the wire schema's optional
 *  fields normalized to explicit nulls. */
export interface NormalizedLocation {
  file: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}

/** The location shape both sources carry: the live wire schema (optional fields)
 *  and the persisted ts-rs projection (explicit nulls). */
export interface LocationLike {
  file: string;
  startLine?: number | null;
  endLine?: number | null;
  symbol?: string | null;
}

/** Normalize a grounded location into the view shape (absent → explicit `null`).
 *  This exact block was cloned across the scan `*-stream.ts` normalizers
 *  (insight ×1, scorecard ×4, harness ×1). The non-nullable overload keeps
 *  `evidence.map(normalizeLocation)` free of null checks. */
export function normalizeLocation(loc: LocationLike): NormalizedLocation;
export function normalizeLocation(
  loc: LocationLike | null | undefined,
): NormalizedLocation | null;
export function normalizeLocation(
  loc: LocationLike | null | undefined,
): NormalizedLocation | null {
  if (loc === null || loc === undefined) return null;
  return {
    file: loc.file,
    startLine: loc.startLine ?? null,
    endLine: loc.endLine ?? null,
    symbol: loc.symbol ?? null,
  };
}

/** The stream fields the shared fold manages directly. Every scan stream carries
 *  these; the family's `write` spreads the patch onto its concrete stream. */
export interface ScanFoldCorePatch<FailureReason> {
  runId?: string;
  status?: 'running' | 'completed' | 'failed';
  model?: string | null;
  costUsd?: number;
  usage?: ScanUsage;
  durationMs?: number;
  error?: string | null;
  failureReason?: FailureReason | null;
}

/** One fold transition's output, expressed family-agnostically. The family's
 *  `write` maps `stepState` / `requestedSteps` / `items` onto its own field names
 *  (`categoryState` / `dimensionState` / `lensState`, …) and spreads `core` and
 *  `extra` last-wins in that order. */
export interface ScanFoldPatch<Stream, Item, Step extends string, FailureReason> {
  core?: ScanFoldCorePatch<FailureReason>;
  stepState?: Record<string, ScanStepProgress>;
  requestedSteps?: Step[];
  items?: Item[];
  /** Family-specific fields riding on a shared transition (e.g. Insight's
   *  `scope` on started, Harness's `synthesizing: false` on the terminals). */
  extra?: Partial<Stream>;
}

/** The canonical intermediate form `classify` maps a family event into — the five
 *  skeleton cases every scan fold shares, plus an escape hatch for family-only
 *  events (`apply`) and deliberate no-ops (`ignore`). */
export type ScanFoldAction<Stream, Item, Step extends string, FailureReason> =
  | {
      kind: 'started';
      runId: string;
      model: string | null;
      /** The requested step (category / dimension / lens) set, seeded `pending`. */
      steps?: Step[];
      /** Extra stream fields the started event carries (scope, preserved PR number…). */
      seed?: Partial<Stream>;
    }
  | { kind: 'step-started'; step: Step }
  | {
      kind: 'step-completed';
      step: Step;
      /** The completed batch, already wire→view mapped; replaces the step's items. */
      items: Item[];
      errored: boolean;
      costUsd: number;
      usage?: ScanUsage;
    }
  | {
      kind: 'completed';
      /** The authoritative final item set (absent for item-less families). */
      items?: Item[];
      costUsd: number;
      usage?: ScanUsage;
      durationMs: number;
      extra?: Partial<Stream>;
    }
  | { kind: 'failed'; message: string; reason: FailureReason; extra?: Partial<Stream> }
  | { kind: 'apply'; next: (prev: Stream) => Stream }
  | { kind: 'ignore' };

/** The per-family configuration injected into {@link makeScanFold}. */
export interface ScanFoldSpec<
  Event,
  Stream extends { costUsd: number; usage: ScanUsage },
  Item,
  Step extends string,
  FailureReason,
> {
  /** The idle stream — the reset target for the started event. */
  empty: Stream;
  /** Step-map bindings (absent for step-less families like Issue Triage). */
  steps?: {
    /** Read the per-step progress map (e.g. `s.categoryState`). */
    state: (s: Stream) => Record<string, ScanStepProgress>;
    /** Read the requested step list (e.g. `s.requestedCategories`). */
    requested: (s: Stream) => readonly Step[];
  };
  /** Item-list bindings (absent for item-less families like Issue Triage). */
  items?: {
    /** Read the accumulated items (e.g. `s.findings`). */
    read: (s: Stream) => Item[];
    /** The step an item belongs to (drives replace-batch-by-step). */
    stepOf: (item: Item) => Step;
  };
  /** Write a fold patch onto the stream — the ONLY place the family's field
   *  names appear: `(s, p) => ({ ...s, ...p.core, …mapped fields…, ...p.extra })`. */
  write: (s: Stream, patch: ScanFoldPatch<Stream, Item, Step, FailureReason>) => Stream;
  /** Normalize one family event into the canonical fold action. `prev` is the
   *  stream being folded into (PR-Review preserves `prNumber` across a reset). */
  classify: (
    event: Event,
    prev: Stream,
  ) => ScanFoldAction<Stream, Item, Step, FailureReason>;
}

/**
 * Build a family's fold from the shared skeleton. Every scan reducer had cloned
 * the identical 5-case switch (`started` / `step-started` / `step-completed` /
 * `completed` / `failed`); this factory owns those transitions once — the family
 * contributes only its event→action mapping (`classify`), its field bindings,
 * and its `write` merge.
 */
export function makeScanFold<
  Event,
  Stream extends { costUsd: number; usage: ScanUsage },
  Item,
  Step extends string,
  FailureReason,
>(
  spec: ScanFoldSpec<Event, Stream, Item, Step, FailureReason>,
): (prev: Stream, event: Event) => Stream {
  const { empty, steps, items, write } = spec;
  return (prev, event) => {
    const action = spec.classify(event, prev);
    switch (action.kind) {
      case 'started':
        return write(empty, {
          core: { runId: action.runId, status: 'running', model: action.model },
          ...(steps !== undefined && action.steps !== undefined
            ? {
                stepState: seedStepState(action.steps),
                requestedSteps: action.steps,
              }
            : undefined),
          extra: action.seed,
        });
      case 'step-started': {
        if (steps === undefined) return prev;
        return write(prev, {
          stepState: { ...steps.state(prev), [action.step]: 'running' },
        });
      }
      case 'step-completed': {
        if (steps === undefined || items === undefined) return prev;
        // Replace this step's (optimistic) items with the completed batch.
        const others = items
          .read(prev)
          .filter((i) => items.stepOf(i) !== action.step);
        return write(prev, {
          core: {
            costUsd: prev.costUsd + action.costUsd,
            usage: addUsage(prev.usage, action.usage),
          },
          stepState: {
            ...steps.state(prev),
            [action.step]: action.errored ? 'error' : 'done',
          },
          items: [...others, ...action.items],
        });
      }
      case 'completed':
        return write(prev, {
          core: {
            status: 'completed',
            costUsd: action.costUsd,
            usage: action.usage ?? prev.usage,
            durationMs: action.durationMs,
          },
          ...(steps !== undefined
            ? {
                stepState: settleStepState(
                  steps.requested(prev),
                  steps.state(prev),
                ),
              }
            : undefined),
          ...(action.items !== undefined ? { items: action.items } : undefined),
          extra: action.extra,
        });
      case 'failed':
        return write(prev, {
          core: {
            status: 'failed',
            error: action.message,
            failureReason: action.reason,
          },
          extra: action.extra,
        });
      case 'apply':
        return action.next(prev);
      case 'ignore':
        return prev;
    }
  };
}

/** The inputs to {@link patchStreamItem} — one item's in-place lifecycle mark. */
export interface StreamItemPatch<Stream, Item extends { id: string }> {
  /** The run the notice targets; a stream showing a different run is untouched. */
  runId: string;
  itemId: string;
  /** Read the item list off the stream (e.g. `s.findings`). */
  items: (s: Stream) => Item[];
  /** Write the item list back (e.g. `(s, findings) => ({ ...s, findings })`). */
  write: (s: Stream, items: Item[]) => Stream;
  /** The lifecycle mark (e.g. flip to `converted` with the linked task id). */
  patch: (item: Item) => Item;
}

/**
 * Patch one item (by id) on one run's stream — the shared body of every
 * `*-converted` / `*-applied` notice handler. Matches on `stream.runId` (NOT the
 * live-fold gate) so a mutation against a displayed-but-not-live run still
 * updates in place; any other run's stream is returned untouched.
 */
export function patchStreamItem<
  Stream extends { runId: string | null },
  Item extends { id: string },
>(prev: Stream, opts: StreamItemPatch<Stream, Item>): Stream {
  if (prev.runId !== opts.runId) return prev;
  return opts.write(
    prev,
    opts.items(prev).map((i) => (i.id === opts.itemId ? opts.patch(i) : i)),
  );
}
