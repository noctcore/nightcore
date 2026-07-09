/** Props, seam, and view types for the ModelSelect combobox. */
import type { FocusEvent, KeyboardEvent } from 'react';

import type { EffortLevel, ModelDescriptor, ProviderId } from '@nightcore/contracts';
import type { EffortOption } from '@/lib/models';

import type { KnownProviderId } from '../ProviderIcon';

/** The single value object the ModelSelect controls: the chosen model, its
 *  reasoning-effort override, and (when known) the provider the model belongs to.
 *  One cohesive object with one `onChange` — no prop-bundle drilling. */
export interface ModelSelection {
  /** Model id override sent on the wire, or `null` to inherit the default. */
  model: string | null;
  /** Reasoning-effort override, or `null` to inherit. `none` disables thinking. */
  effort: string | null;
  /** The provider the model belongs to, stamped on pick when it can be resolved. */
  providerId?: ProviderId;
}

/** The injectable catalog seam — stories/tests pass an in-memory variant so the
 *  picker renders without the live bridge. `sync` seeds `ready` on first render
 *  (the static `@/lib/models` fallback — no loading flash); `async` starts
 *  `loading` and resolves via `load` (B5's live `listModels()` bridge loader). */
export type ModelCatalogData =
  | { readonly mode: 'sync'; readonly read: () => ModelDescriptor[] }
  | { readonly mode: 'async'; readonly load: () => Promise<ModelDescriptor[]> };

/** The parent-owned catalog state passed into ModelSelect — a discriminated union
 *  the thin shell renders directly (skeleton / soft error+retry / grouped list).
 *  Produced by {@link useModelCatalog}; owning the state in the parent keeps
 *  ModelSelect a presentational shell. */
export type ModelCatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly retry?: () => void }
  | { readonly status: 'ready'; readonly models: ModelDescriptor[] };

/** Props for ModelSelect. The selection is one value object with a single
 *  `onChange`; the catalog is a parent-owned discriminated union. */
export interface ModelSelectProps {
  /** The current selection (model + effort + optional provider). Controlled. */
  value: ModelSelection;
  /** Fired with the next selection whenever the model or effort changes. */
  onChange: (next: ModelSelection) => void;
  /** The parent-owned catalog state (loading | error | ready). */
  catalog: ModelCatalogState;
  /** Disable the whole control (input + dropdown + effort row). */
  disabled?: boolean;
  /** Accessible name for the combobox (and the listbox). Defaults to "Model". */
  ariaLabel?: string;
  /** Whether to render the reasoning-effort row. Defaults to `true`; the live
   *  wrapper gates it on provider `supportsEffort` capability so a
   *  provider with no effort control (e.g. a future one) hides the row entirely. */
  showEffort?: boolean;
}

/** One selectable model row in the listbox, pre-assigned its flat keyboard-nav
 *  index + stable option id, enriched with web display metadata. `value` is
 *  `null` for the synthetic Inherit row. */
export interface ModelRow {
  value: string | null;
  label: string;
  description: string;
  /** Tier badge text (Premium/Balanced/Speed), or null when unknown. */
  tier: string | null;
  /** The provider the model belongs to (for the row's brand glyph), or null. */
  provider: KnownProviderId | null;
  /** Effort levels from the live descriptor, when this is a real model row. */
  supportedEffortLevels: EffortLevel[];
  /** Position in the flat selectable list (Inherit → groups, in display order). */
  index: number;
  /** DOM id for the `role="option"` element. */
  id: string;
}

/** A provider-grouped run of option rows (rendered as a listbox `role="group"`).
 *  `provider` is `null` for the fallback bucket of models with no known brand. */
export interface ProviderGroup {
  provider: KnownProviderId | null;
  label: string;
  rows: ModelRow[];
}

/** The trigger's rendered summary of the current selection. */
export interface SelectedSummary {
  label: string;
  description: string;
  provider: KnownProviderId | null;
}

/** The inline effort radiogroup's model-aware view. */
export interface EffortRowView {
  /** The current effort value (`null` = Inherit, `none` = disable thinking). */
  value: string | null;
  /** The effort levels the selected model surfaces, plus the `none` sentinel. */
  options: EffortOption[];
  /** Whether the selected model reasons adaptively at Inherit (Opus/Fable). */
  adaptive: boolean;
  /** The selected model's label, for the adaptive hint. */
  activeLabel: string | null;
}

/** Everything the thin ModelSelect shell renders — combobox open/highlight state,
 *  the grouped rows, the selected summary, the effort row, and the handlers.
 *  Computed by {@link useModelSelect}. */
export interface ModelSelectView {
  /** Whether the dropdown is open (always false while disabled or not ready). */
  open: boolean;
  /** id of the listbox element (the combobox's `aria-controls`). */
  listboxId: string;
  /** id of the highlighted option (the combobox's `aria-activedescendant`). */
  activeOptionId: string | undefined;
  /** The flat index currently highlighted (-1 when there is nothing to pick). */
  highlight: number;
  /** The synthetic Inherit row (rendered above the provider groups). */
  inheritRow: ModelRow;
  /** The provider-grouped option rows, in display order. */
  groups: ProviderGroup[];
  /** The trigger's summary of the current selection. */
  selected: SelectedSummary;
  /** The resolved catalog value of the current selection (`null` = Inherit). */
  selectedValue: string | null;
  /** The inline effort radiogroup's view. */
  effort: EffortRowView;
  /** Toggle the dropdown open/closed (pointer). */
  onTriggerClick: () => void;
  /** Arrow up/down move the highlight, Enter/Space pick, Esc closes. */
  onTriggerKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  /** Close the menu when focus leaves the whole combobox. */
  onContainerBlur: (e: FocusEvent<HTMLDivElement>) => void;
  /** Move the highlight to a row under the pointer. */
  onHighlight: (index: number) => void;
  /** Pick a model by value (reconciles a now-unsupported effort, closes). */
  selectModel: (value: string | null) => void;
  /** Pick an effort level (keeps the model + provider). */
  selectEffort: (effort: string | null) => void;
}
