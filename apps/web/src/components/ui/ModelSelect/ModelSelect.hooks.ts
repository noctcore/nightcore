/** The ModelSelect data seam + combobox state machine. The `.tsx` shell is a
 *  thin presentation layer; everything stateful and derived lives here. */
import type { FocusEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { ModelDescriptor } from '@nightcore/contracts';
import {
  effortOptionsForModel,
  isAdaptiveModel,
  isEffortSupported,
  MODEL_OPTIONS,
  type ModelOption,
  modelOptionFor,
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

/** Shape a web `ModelOption` as the contract `ModelDescriptor` the catalog trades
 *  in, so the static fallback is the same currency the live `listModels()` seam
 *  returns — B5 swaps the loader without a component change. */
function optionToDescriptor(option: ModelOption): ModelDescriptor {
  return {
    value: option.id,
    displayName: option.label,
    description: option.description,
    supportsEffort: option.supportsEffort,
    supportedEffortLevels: option.supportedEfforts,
  };
}

/** The static catalog seam — resolves synchronously from the curated
 *  `@/lib/models` stand-in, so the picker lands in `ready` with no loading flash.
 *  B5 replaces this with an `async` bridge loader once the live seam lands. */
export const STATIC_MODEL_CATALOG_DATA: ModelCatalogData = {
  mode: 'sync',
  read: () => MODEL_OPTIONS.map(optionToDescriptor),
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

/** Group the catalog by provider (inferred from the model id), assigning each kept
 *  row its flat keyboard-nav index (Inherit → groups) plus a stable option id, and
 *  enriching each with web tier metadata. Pure. */
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

  let index = 1;
  const order: (ReturnType<typeof resolveProviderForModel>)[] = [];
  const buckets = new Map<ReturnType<typeof resolveProviderForModel>, ModelRow[]>();
  for (const descriptor of models) {
    const provider = resolveProviderForModel(descriptor.value);
    const meta = modelOptionFor(descriptor.value);
    const row: ModelRow = {
      value: descriptor.value,
      label: descriptor.displayName,
      description: descriptor.description,
      tier: meta?.tier ?? null,
      provider,
      index: index++,
      id: `${baseId}-opt-${index}`,
    };
    const bucket = buckets.get(provider);
    if (bucket === undefined) {
      buckets.set(provider, [row]);
      order.push(provider);
    } else {
      bucket.push(row);
    }
  }

  const groups: ProviderGroup[] = order.map((provider) => ({
    provider,
    label: provider !== null ? providerLabel(provider) : 'Other',
    rows: buckets.get(provider) ?? [],
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
