/**
 * The generic scan-fold factory. Every scan reducer had cloned the identical
 * 5-case switch (`started` / `step-started` / `step-completed` / `completed` /
 * `failed`); {@link makeScanFold} owns those transitions once — each family
 * contributes only its event→action mapping (`classify`), its field bindings, and
 * its `write` merge. Re-exported from the `@/lib/scan-run` barrel; mirrors the
 * backend's `scan_lifecycle_commands!` macro over generic `ScanStore` / `ScanRun`.
 */
import {
  addUsage,
  type ScanStepProgress,
  type ScanUsage,
  seedStepState,
  settleStepState,
} from './lifecycle';

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
