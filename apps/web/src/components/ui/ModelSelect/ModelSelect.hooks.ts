/** The ModelSelect data seam + combobox state machine. The `.tsx` shell is a
 *  thin presentation layer; everything stateful and derived lives here. */
import type { FocusEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { ModelDescriptor } from '@nightcore/contracts';
import {
  effortOptionsForModel,
  isAdaptiveModel,
  isEffortSupported,
  modelOptionFor,
  staticModelDescriptors,
} from '@/lib/models';

import { providerLabel, resolveProviderForModel } from '../ProviderIcon';
import type {
  EffortRowView,
  ModelCatalogData,
  ModelCatalogState,
  ModelRow,
  ModelSelection,
  ModelSelectView,
  ProviderGroup,
  SelectedSummary,
} from './ModelSelect.types';

/** The static catalog seam — resolves synchronously from the curated
 *  `@/lib/models` stand-in (shaped via the shared {@link staticModelDescriptors}),
 *  so the picker lands in `ready` with no loading flash. The live `async` bridge
 *  loader (`ModelSelectField`'s `LIVE_MODEL_CATALOG_DATA`) returns the same
 *  `ModelDescriptor[]` currency, so a surface swaps the seam without touching this
 *  presentational component. */
export const STATIC_MODEL_CATALOG_DATA: ModelCatalogData = {
  mode: 'sync',
  read: staticModelDescriptors,
};

/**
 * The catalog load lifecycle, modeled on `useProviderConfig`: a cancel-guarded
 * fetch behind an injectable seam, surfaced as a discriminated union the parent
 * hands to {@link ModelSelectView}. The default (static) seam is synchronous, so
 * the hook initializes straight to `ready`; the `async` seam starts `loading` and
 * resolves to `ready`/`error` with a `retry`. The effect keys on `data.mode` (a
 * primitive) and reads the seam from a live ref, so passing a fresh seam object
 * each render can't refetch-loop — the load re-runs only when the mode flips or
 * `retry` fires.
 */
export function useModelCatalog(
  data: ModelCatalogData = STATIC_MODEL_CATALOG_DATA,
): ModelCatalogState {
  const dataRef = useRef(data);
  dataRef.current = data;
  const [state, setState] = useState<ModelCatalogState>(() =>
    data.mode === 'sync' ? { status: 'ready', models: data.read() } : { status: 'loading' },
  );
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const seam = dataRef.current;
    if (seam.mode === 'sync') {
      setState({ status: 'ready', models: seam.read() });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    seam
      .load()
      .then((models) => {
        if (!cancelled) setState({ status: 'ready', models });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message, retry });
      });
    return () => {
      cancelled = true;
    };
  }, [data.mode, attempt, retry]);

  return state;
}

/** The provider a row belongs to (a known brand id, or `null` for the fallback
 *  bucket) — the resolver's return type. */
type RowProvider = ReturnType<typeof resolveProviderForModel>;

/** A model row before its position is known — bucketed by provider first, then
 *  stamped with the flat keyboard-nav index + option id during the final flatten. */
type PendingRow = Omit<ModelRow, 'index' | 'id'>;

/** Group the catalog by provider (inferred from the model id), then assign each
 *  kept row its flat keyboard-nav index (Inherit → groups) plus a stable option id
 *  *from that final grouped order* — NOT catalog-iteration order. The two diverge
 *  whenever the catalog interleaves providers (e.g. `[claude, codex, claude]`);
 *  keying `index`/`id` off the flattened order keeps `row.index` equal to the row's
 *  position in `flatRows`, so the highlight, `aria-activedescendant`, and the
 *  Enter-target never disagree. Also enriches each row with web tier metadata.
 *  Pure. */
function buildGroups(
  models: ModelDescriptor[],
  baseId: string,
): { inheritRow: ModelRow; groups: ProviderGroup[]; count: number } {
  const inheritRow: ModelRow = {
    value: null,
    label: 'Inherit',
    description: 'Use the default model',
    tier: null,
    provider: null,
    index: 0,
    id: `${baseId}-opt-inherit`,
  };

  // Bucket by provider in first-seen order, WITHOUT assigning positions yet.
  const order: RowProvider[] = [];
  const buckets = new Map<RowProvider, PendingRow[]>();
  for (const descriptor of models) {
    const provider = resolveProviderForModel(descriptor.value);
    const meta = modelOptionFor(descriptor.value);
    const row: PendingRow = {
      value: descriptor.value,
      label: descriptor.displayName,
      description: descriptor.description,
      tier: meta?.tier ?? null,
      provider,
    };
    const bucket = buckets.get(provider);
    if (bucket === undefined) {
      buckets.set(provider, [row]);
      order.push(provider);
    } else {
      bucket.push(row);
    }
  }

  // Flatten in grouped order (Inherit is index 0; provider rows follow), stamping
  // each row's flat index + option id from that final order. `.map` runs the groups
  // and their rows sequentially, so the shared counter walks the flat list in
  // display order — exactly the order `flatRows` is later assembled in.
  let index = 1;
  const groups: ProviderGroup[] = order.map((provider) => ({
    provider,
    label: provider !== null ? providerLabel(provider) : 'Other',
    rows: (buckets.get(provider) ?? []).map((row) => {
      const flat: ModelRow = { ...row, index, id: `${baseId}-opt-${index}` };
      index += 1;
      return flat;
    }),
  }));
  return { inheritRow, groups, count: index };
}

/** Resolve which catalog row the stored model value selects — an exact match
 *  first, then the `@/lib/models` family match (legacy short ids), else Inherit
 *  (`null`). Pure. */
function resolveSelectedValue(model: string | null, rows: ModelRow[]): string | null {
  if (model === null) return null;
  if (rows.some((row) => row.value === model)) return model;
  const canonical = modelOptionFor(model)?.id ?? null;
  if (canonical !== null && rows.some((row) => row.value === canonical)) return canonical;
  return null;
}

/** Inputs the combobox hook needs from the ModelSelect props. */
interface UseModelSelectArgs {
  value: ModelSelection;
  onChange: (next: ModelSelection) => void;
  catalog: ModelCatalogState;
  disabled: boolean;
}

const NO_MODELS: ModelDescriptor[] = [];

/**
 * The ModelSelect combobox state machine: dropdown visibility, the
 * provider-grouped rows, the highlighted index, keyboard handlers, and the
 * model/effort selection logic. Fully controlled — the value object flows back
 * through the single `onChange`; this hook holds only the ephemeral open/highlight
 * UI state. Picking a model reconciles a now-unsupported effort back to Inherit
 * (Opus `max` → null when switching to Haiku), mirroring the ModelEffortPicker.
 */
export function useModelSelect({
  value,
  onChange,
  catalog,
  disabled,
}: UseModelSelectArgs): ModelSelectView {
  const baseId = useId();
  const [openState, setOpen] = useState(false);
  const [rawHighlight, setHighlight] = useState(0);

  const models = catalog.status === 'ready' ? catalog.models : NO_MODELS;
  const { inheritRow, groups, count } = useMemo(
    () => buildGroups(models, baseId),
    [models, baseId],
  );
  const flatRows = useMemo(
    () => [inheritRow, ...groups.flatMap((group) => group.rows)],
    [inheritRow, groups],
  );

  const open = openState && !disabled && catalog.status === 'ready';
  // Clamp so a shrinking list can never leave the highlight pointing past the end.
  const highlight = count === 0 ? -1 : Math.min(Math.max(rawHighlight, 0), count - 1);

  const selectedValue = resolveSelectedValue(value.model, flatRows);
  const selectedRow = flatRows.find((row) => row.value === selectedValue) ?? inheritRow;
  const selected: SelectedSummary = {
    label: selectedRow.label,
    description: selectedRow.description,
    provider: selectedRow.provider,
  };

  const effort: EffortRowView = {
    value: value.effort,
    options: effortOptionsForModel(value.model),
    adaptive: isAdaptiveModel(value.model),
    activeLabel: modelOptionFor(value.model)?.label ?? null,
  };

  function selectModel(next: string | null): void {
    const provider = next !== null ? resolveProviderForModel(next) : null;
    const nextEffort = isEffortSupported(next, value.effort) ? value.effort : null;
    onChange({ model: next, effort: nextEffort, providerId: provider ?? undefined });
    setOpen(false);
  }

  function selectEffort(nextEffort: string | null): void {
    onChange({ ...value, effort: nextEffort });
  }

  function openMenu(): void {
    if (disabled || catalog.status !== 'ready') return;
    const selectedIndex = flatRows.findIndex((row) => row.value === selectedValue);
    setOpen(true);
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  }

  function selectIndex(target: number): void {
    const row = flatRows[target];
    if (row !== undefined) selectModel(row.value);
  }

  function onTriggerClick(): void {
    if (disabled || catalog.status !== 'ready') return;
    if (open) setOpen(false);
    else openMenu();
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled || catalog.status !== 'ready') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu();
      else if (count > 0) setHighlight((highlight + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openMenu();
      else if (count > 0) setHighlight((highlight - 1 + count) % count);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open && highlight >= 0) selectIndex(highlight);
      else openMenu();
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  function onContainerBlur(e: FocusEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  }

  function onHighlight(index: number): void {
    setHighlight(index);
  }

  const activeRow = highlight >= 0 ? flatRows[highlight] : undefined;

  return {
    open,
    listboxId: `${baseId}-listbox`,
    activeOptionId: open ? activeRow?.id : undefined,
    highlight,
    inheritRow,
    groups,
    selected,
    selectedValue,
    effort,
    onTriggerClick,
    onTriggerKeyDown,
    onContainerBlur,
    onHighlight,
    selectModel,
    selectEffort,
  };
}
