/**
 * The finding-selection slice of the PR workspace — split out of the
 * PrReviewView mega-hook along its "finding selection" concern: the detail-panel
 * selection, the post-selection checkbox set (with auto-select-on-completion),
 * the per-finding lifecycle actions against the DISPLAYED run (convert /
 * dismiss / restore + bulk convert-all), and the sorted grid projection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  convertReviewFindingToTask,
  dismissReviewFinding,
  type PrReviewRun,
  restoreReviewFinding,
  type Task,
} from '@/lib/bridge';
import { sortBySeverityThenStatus } from '@/lib/severity';
import { type BulkConvertProgress, useBulkConvert } from '@/lib/useBulkConvert';

import type { ReviewFindingView } from './prreview.types';
import type { ReviewStream } from './prreview-stream';

/** The workspace slices the selection layer acts against. */
export interface PrFindingSelectionConfig {
  /** Project identity — a switch resets the selection synchronously. */
  projectPath: string | null;
  /** The displayed run's id (every action targets it), or null. */
  displayRunId: string | null;
  /** The displayed stream (findings + status), or null. */
  displayStream: ReviewStream | null;
  /** Authoritative registry reload of one run (after a mutation). */
  selectRun: (runId: string) => Promise<ReviewStream | null>;
  /** Re-list persisted runs (history reconcile after a mutation). */
  refreshRuns: () => Promise<PrReviewRun[]>;
}

/** Everything the selection layer exposes to the workspace composition. */
export interface PrFindingSelectionApi {
  /** The finding open in the detail panel, or `null`. */
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selected: ReviewFindingView | null;
  /** The displayed run's findings, open-first then severity (high→low). */
  gridFindings: ReviewFindingView[];
  /** True while a finding action (convert/dismiss/restore) is in flight. */
  pending: boolean;
  runAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  convertFinding: (findingId: string) => Promise<Task | null>;
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  /** The findings checked for inclusion in the posted review. */
  selection: ReadonlySet<string>;
  onToggleSelect: (findingId: string) => void;
  onSelectionChange: (next: ReadonlySet<string>) => void;
  /** Clear the post selection (after a successful post). */
  clearSelection: () => void;
  /** Selected, non-dismissed findings (the post payload). */
  selectedFindings: ReviewFindingView[];
  selectedCount: number;
  /** How many selected findings carry a line anchor (become inline comments). */
  selectedInlineCount: number;
  /** Only OPEN selected findings (the fix prompt's payload). */
  selectedOpenFindings: ReviewFindingView[];
  /** Drop the per-run finding UI (detail panel, post selection, bulk counters)
   *  — applied when the displayed run changes (PR switch, history, new run). */
  resetFindingUi: () => void;
  // Bulk convert-all (shared with the Insight sibling).
  convertAll: (targets: readonly { id: string }[]) => void;
  bulkConverting: boolean;
  bulkProgress: BulkConvertProgress;
  bulkStatusMessage: string;
  bulkError: string | null;
}

/** Own the finding selection + lifecycle actions for the displayed run. */
export function usePrFindingSelection({
  projectPath,
  displayRunId,
  displayStream,
  selectRun,
  refreshRuns,
}: PrFindingSelectionConfig): PrFindingSelectionApi {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The findings checked for inclusion in the posted review.
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());

  // Project-switch reset, synchronously before paint (the render-adjust
  // pattern): the selection belongs to the previous project's PR numbers.
  const [lastProject, setLastProject] = useState(projectPath);
  if (lastProject !== projectPath) {
    setLastProject(projectPath);
    setSelectedId(null);
    setSelection(new Set());
  }

  const gridFindings = useMemo(
    () => sortBySeverityThenStatus(displayStream?.findings ?? []),
    [displayStream?.findings],
  );

  const selected = useMemo(
    () => displayStream?.findings.find((f) => f.id === selectedId) ?? null,
    [displayStream?.findings, selectedId],
  );

  // Auto-select on completion: when the DISPLAYED run first reaches `completed`
  // carrying open findings, seed the post selection with ALL of them (every
  // finding — even low — is worth surfacing to the contributor, mirroring the
  // reference). Guarded per run id + never stomps an existing selection, so a
  // user's None (or a narrowed pick) survives a later re-fold: each run seeds at
  // most once, and only into an empty selection. The completed edge can arrive
  // before the persisted reconcile brings the findings, hence the deferral until
  // there is something open to seed (a genuinely clean run seeds nothing).
  const autoSelectedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (displayStream?.status !== 'completed' || displayRunId === null) return;
    if (autoSelectedRunRef.current === displayRunId) return;
    const openIds = displayStream.findings
      .filter((f) => f.status === 'open')
      .map((f) => f.id);
    if (openIds.length === 0) return;
    autoSelectedRunRef.current = displayRunId;
    setSelection((prev) => (prev.size === 0 ? new Set(openIds) : prev));
  }, [displayRunId, displayStream?.status, displayStream?.findings]);

  // --- Finding lifecycle actions (against the DISPLAYED run) -------------
  // Bulk convert-all progress + loop (shared with the Insight sibling). The
  // convert closure is read through a ref inside, so rebinding on the displayed
  // run is safe.
  const convertFinding = useCallback(
    async (findingId: string): Promise<Task | null> => {
      if (displayRunId === null) return null;
      const task = await convertReviewFindingToTask(displayRunId, findingId);
      // The `pr-review-finding-converted` event folds the registry too; the
      // explicit persisted reconcile makes the mark deterministic.
      await selectRun(displayRunId);
      void refreshRuns();
      return task;
    },
    [displayRunId, selectRun, refreshRuns],
  );
  const {
    resetBulk,
    convertAll,
    bulkConverting,
    bulkProgress,
    bulkStatusMessage,
    bulkError,
  } = useBulkConvert(convertFinding, 'convertReviewFindingToTask failed');

  /** Drop the per-run finding UI (detail panel, post selection, bulk counters)
   *  — applied when the displayed run changes (PR switch, history, new run). */
  const resetFindingUi = useCallback(() => {
    setSelectedId(null);
    setSelection(new Set());
    resetBulk();
  }, [resetBulk]);

  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setPending(true);
      try {
        await fn();
      } catch (err) {
        console.error(`${label} finding failed`, err);
        toast.error(`Could not ${label} finding`, err);
      } finally {
        setPending(false);
      }
    },
    [toast],
  );

  const dismiss = useCallback(
    async (findingId: string) => {
      if (displayRunId === null) return;
      await dismissReviewFinding(displayRunId, findingId);
      await selectRun(displayRunId);
      void refreshRuns();
    },
    [displayRunId, selectRun, refreshRuns],
  );

  const restore = useCallback(
    async (findingId: string) => {
      if (displayRunId === null) return;
      await restoreReviewFinding(displayRunId, findingId);
      await selectRun(displayRunId);
      void refreshRuns();
    },
    [displayRunId, selectRun, refreshRuns],
  );

  const onToggleSelect = useCallback((findingId: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(findingId)) next.delete(findingId);
      else next.add(findingId);
      return next;
    });
  }, []);

  // Bulk replace: the ReviewFindings quick-select presets and per-group tri-state
  // toggles compose the next selection (over OPEN findings) and hand it up here.
  const onSelectionChange = useCallback((next: ReadonlySet<string>) => {
    setSelection(new Set(next));
  }, []);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  // Dismiss also deselects — a dismissed finding must not be posted. The
  // deselect is optimistic: a FAILED dismiss restores the selection (the
  // finding is still open and postable, so silently dropping it would shrink
  // the composed review with no signal beyond the toast).
  const onDismiss = useCallback(
    (id: string) => {
      const wasSelected = selection.has(id);
      if (wasSelected) {
        setSelection((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      void runAction('dismiss', async () => {
        try {
          await dismiss(id);
        } catch (err) {
          if (wasSelected) {
            setSelection((prev) => {
              if (prev.has(id)) return prev;
              const next = new Set(prev);
              next.add(id);
              return next;
            });
          }
          throw err;
        }
      });
    },
    [selection, runAction, dismiss],
  );

  // --- Selection projections ----------------------------------------------
  const selectedFindings = useMemo(
    () =>
      (displayStream?.findings ?? []).filter(
        (f) => selection.has(f.id) && f.status !== 'dismissed',
      ),
    [displayStream?.findings, selection],
  );
  const selectedCount = selectedFindings.length;
  const selectedInlineCount = useMemo(
    () => selectedFindings.filter((f) => f.line !== null).length,
    [selectedFindings],
  );
  /** Only OPEN selected findings feed the fix prompt (converted stay postable
   *  but are already tracked as tasks; dismissed never make the selection). */
  const selectedOpenFindings = useMemo(
    () => selectedFindings.filter((f) => f.status === 'open'),
    [selectedFindings],
  );

  return {
    selectedId,
    setSelectedId,
    selected,
    gridFindings,
    pending,
    runAction,
    convertFinding,
    onConvert: (id) => void runAction('convert', () => convertFinding(id)),
    onDismiss,
    onRestore: (id) => void runAction('restore', () => restore(id)),
    selection,
    onToggleSelect,
    onSelectionChange,
    clearSelection,
    selectedFindings,
    selectedCount,
    selectedInlineCount,
    selectedOpenFindings,
    resetFindingUi,
    convertAll,
    bulkConverting,
    bulkProgress,
    bulkStatusMessage,
    bulkError,
  };
}
