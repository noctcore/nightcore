/** The PR list's filter bar: an author multi-select, a lifecycle-status
 *  multi-select, and a sort control, plus a reset-all that appears once any
 *  filter (or a non-default sort) is active. It sits above the list rows and
 *  complements — never replaces — the text/manual-number box above it. Each
 *  dropdown is a keyboard-navigable anchored popover (see
 *  {@link ./PrFilterBar.hooks}), rebuilt from the reference on Nightcore
 *  primitives + semantic tokens. Author/status values are gh pass-through
 *  (untrusted contributor logins) rendered as inert text. */
import type { ComponentType, ReactNode } from 'react';

import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  GithubIcon,
  LayersIcon,
  SearchIcon,
  SlidersIcon,
} from '@/components/ui';

import { LIFECYCLE_FILTER_OPTIONS, type ReviewLifecycleState } from '../prreview-lifecycle';
import { useFilterDropdown } from './PrFilterBar.hooks';
import type { PrFilterBarProps, PrSortOption } from './PrFilterBar.types';

/** The shared icon-component shape (Nightcore icons accept an optional size +
 *  className). */
type IconComponent = ComponentType<{ size?: number; className?: string }>;

/** Sort options in display order, with their trigger/menu glyphs + labels. */
const SORT_ORDER: PrSortOption[] = ['newest', 'oldest', 'largest'];
const SORT_META: Record<PrSortOption, { label: string; icon: IconComponent }> = {
  newest: { label: 'Newest', icon: ClockIcon },
  oldest: { label: 'Oldest', icon: ClockIcon },
  largest: { label: 'Largest', icon: LayersIcon },
};

/** Lifecycle-state → filter label (falls back to the raw state, never blank). */
function statusLabel(state: ReviewLifecycleState): string {
  return LIFECYCLE_FILTER_OPTIONS.find((o) => o.state === state)?.label ?? state;
}

/** Shared trigger-button chrome — dashed + muted when idle, solid + primary-tinted
 *  once a value is chosen (the reference's dashed→solid affordance). */
function triggerClass(active: boolean): string {
  return `inline-flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] border px-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
    active
      ? 'border-primary/50 bg-primary/[0.08] text-foreground'
      : 'border-dashed border-border bg-transparent text-muted-foreground hover:border-white/25 hover:text-foreground'
  }`;
}

/** A small selected-count badge shown in a multi-select trigger. */
function CountBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-primary/20 px-1.5 py-px font-mono text-[10px] font-semibold text-primary">
      {count}
    </span>
  );
}

/** The multi-select box glyph: filled check when chosen, else an empty box. */
function CheckGlyph({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-white/[0.02]'
      }`}
    >
      {checked && <CheckIcon size={10} />}
    </span>
  );
}

/** The single-select radio glyph for the sort menu. */
function RadioGlyph({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border transition-colors ${
        checked ? 'border-primary text-primary' : 'border-border'
      }`}
    >
      {checked && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
    </span>
  );
}

/** A generic anchored multi-select dropdown (authors / statuses). Values are
 *  strings; `renderItem` maps each to its labelled row. */
function MultiSelectDropdown<T extends string>({
  title,
  icon: Icon,
  items,
  selected,
  onChange,
  renderItem,
  searchable = false,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
}: {
  title: string;
  icon: IconComponent;
  items: readonly T[];
  selected: readonly T[];
  onChange: (next: readonly T[]) => void;
  renderItem: (item: T) => ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel: string;
  disabled?: boolean;
}) {
  const selectedSet = new Set(selected);
  const toggleItem = (item: T) =>
    onChange(selectedSet.has(item) ? selected.filter((s) => s !== item) : [...selected, item]);
  const dd = useFilterDropdown<T>(items, { onActivate: toggleItem });

  return (
    <div ref={dd.rootRef} className="relative inline-flex">
      <button
        ref={dd.triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={dd.open}
        disabled={disabled}
        onClick={dd.toggle}
        className={triggerClass(selected.length > 0)}
      >
        <Icon size={12} />
        <span className="truncate">{title}</span>
        {selected.length > 0 && <CountBadge count={selected.length} />}
        <ChevronDownIcon size={11} className="shrink-0 opacity-70" />
      </button>
      {dd.open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-[228px] overflow-hidden rounded-[10px] border border-border bg-popover shadow-2xl"
          style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
        >
          <div className="border-b border-border px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {title}
            </span>
            {searchable && (
              <div className="mt-1.5 flex items-center gap-1.5 rounded-[7px] border border-border bg-black/20 px-2">
                <SearchIcon size={12} className="shrink-0 text-muted-foreground" />
                <input
                  ref={dd.searchInputRef}
                  type="text"
                  value={dd.searchTerm}
                  onChange={(e) => dd.setSearchTerm(e.target.value)}
                  onKeyDown={dd.onSearchKeyDown}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder ?? `Search ${title}`}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-transparent py-1.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
                />
              </div>
            )}
          </div>
          <div
            ref={dd.listRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label={title}
            aria-activedescendant={dd.activeDescendantId}
            tabIndex={0}
            onKeyDown={dd.onListKeyDown}
            className="max-h-[240px] overflow-y-auto p-1 focus:outline-none"
          >
            {dd.filteredItems.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">{emptyLabel}</p>
            ) : (
              dd.filteredItems.map((item, index) => {
                const isSelected = selectedSet.has(item);
                const isFocused = index === dd.focusedIndex;
                return (
                  <div
                    key={item}
                    id={dd.optionId(index)}
                    ref={(el) => {
                      dd.itemRefs.current[index] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    onClick={() => toggleItem(item)}
                    onKeyDown={(e) => {
                      // The listbox host owns roving keyboard nav; this mirrors
                      // activation for direct focus + satisfies the a11y rule.
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleItem(item);
                      }
                    }}
                    className={`flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] transition-colors hover:bg-white/[0.06] ${
                      isFocused ? 'bg-white/[0.08] ring-1 ring-inset ring-primary/50' : ''
                    }`}
                  >
                    <CheckGlyph checked={isSelected} />
                    {renderItem(item)}
                  </div>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => onChange([])}
                className="w-full rounded-[6px] py-1.5 text-center text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The single-select sort dropdown. */
function SortDropdown({
  value,
  onChange,
  disabled = false,
}: {
  value: PrSortOption;
  onChange: (value: PrSortOption) => void;
  disabled?: boolean;
}) {
  const dd = useFilterDropdown<PrSortOption>(SORT_ORDER, {
    onActivate: onChange,
    closeOnActivate: true,
  });
  const Current = SORT_META[value].icon;

  return (
    <div ref={dd.rootRef} className="relative inline-flex">
      <button
        ref={dd.triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={dd.open}
        disabled={disabled}
        onClick={dd.toggle}
        className={triggerClass(false)}
      >
        <Current size={12} />
        <span className="truncate">{SORT_META[value].label}</span>
        <ChevronDownIcon size={11} className="shrink-0 opacity-70" />
      </button>
      {dd.open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-[180px] overflow-hidden rounded-[10px] border border-border bg-popover shadow-2xl"
          style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
        >
          <div className="border-b border-border px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Sort by
            </span>
          </div>
          <div
            ref={dd.listRef}
            role="listbox"
            aria-label="Sort by"
            aria-activedescendant={dd.activeDescendantId}
            tabIndex={0}
            onKeyDown={dd.onListKeyDown}
            className="p-1 focus:outline-none"
          >
            {dd.filteredItems.map((option, index) => {
              const meta = SORT_META[option];
              const Icon = meta.icon;
              const isSelected = option === value;
              const isFocused = index === dd.focusedIndex;
              return (
                <div
                  key={option}
                  id={dd.optionId(index)}
                  ref={(el) => {
                    dd.itemRefs.current[index] = el;
                  }}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={-1}
                  onClick={() => {
                    onChange(option);
                    dd.close();
                  }}
                  onKeyDown={(e) => {
                    // The listbox host owns roving nav; this mirrors activation
                    // for direct focus + satisfies the a11y rule.
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onChange(option);
                      dd.close();
                    }
                  }}
                  className={`flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] transition-colors hover:bg-white/[0.06] ${
                    isFocused ? 'bg-white/[0.08] ring-1 ring-inset ring-primary/50' : ''
                  }`}
                >
                  <RadioGlyph checked={isSelected} />
                  <Icon size={13} className="shrink-0 text-muted-foreground" />
                  <span>{meta.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function PrFilterBar({
  authors,
  selectedAuthors,
  onAuthorsChange,
  selectedStatuses,
  onStatusesChange,
  sort,
  onSortChange,
  hasActiveFilters,
  onReset,
  disabled = false,
}: PrFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      <MultiSelectDropdown
        title="Author"
        icon={GithubIcon}
        items={authors}
        selected={selectedAuthors}
        onChange={onAuthorsChange}
        renderItem={(author) => <span className="truncate">@{author}</span>}
        searchable
        searchPlaceholder="Search authors…"
        emptyLabel="No authors"
        disabled={disabled}
      />
      <MultiSelectDropdown
        title="Status"
        icon={SlidersIcon}
        items={LIFECYCLE_FILTER_OPTIONS.map((o) => o.state)}
        selected={selectedStatuses}
        onChange={onStatusesChange}
        renderItem={(state) => <span className="truncate">{statusLabel(state)}</span>}
        emptyLabel="No statuses"
        disabled={disabled}
      />
      <SortDropdown value={sort} onChange={onSortChange} disabled={disabled} />
      {hasActiveFilters && (
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-[8px] px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CloseIcon size={12} />
          Reset
        </button>
      )}
    </div>
  );
}
