/** State + keyboard-navigation for one filter-bar dropdown popover. Each dropdown
 *  (authors / statuses / sort) is a small anchored panel that opens on its
 *  trigger, closes on outside-click / Esc / tab-out, and supports full arrow-key
 *  navigation with Enter/Space activation — the reference's keyboard-navigable
 *  menu, rebuilt on Nightcore primitives. Item values are strings, so the search
 *  box filters by the value directly. All state lives here (the bar's `.tsx` is a
 *  thin shell), and this is the file's only exported hook. */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface UseFilterDropdown<T extends string> {
  /** Whether the popover is open. */
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Anchor root (trigger + panel) — outside-click/tab-out closes on it. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** The trigger `<button>` — an in-panel close (Esc / single-select pick)
   *  returns DOM focus here so it never drops to `<body>` (WCAG 2.4.3). */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The `role="listbox"` navigation host inside the panel. */
  listRef: RefObject<HTMLDivElement | null>;
  /** The search box (present only for searchable dropdowns). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  /** The items after the search filter (identity when no search / term empty). */
  filteredItems: T[];
  /** The roving-focus index into {@link filteredItems}, or -1. */
  focusedIndex: number;
  /** The stable DOM id for the option row at `index` — set on each `role="option"`
   *  so the listbox host can point `aria-activedescendant` at the focused one. */
  optionId: (index: number) => string;
  /** The focused option's id for the listbox host's `aria-activedescendant`
   *  (roving model — DOM focus stays on the host), or undefined when nothing is
   *  roving-focused. */
  activeDescendantId: string | undefined;
  /** Per-option element refs (for scroll-into-view on keyboard focus). */
  itemRefs: MutableRefObject<(HTMLElement | null)[]>;
  /** Keydown handler for the listbox host (arrows / Enter / Space / Esc). */
  onListKeyDown: (event: ReactKeyboardEvent) => void;
  /** Keydown handler for the search box (ArrowDown → list, Enter activates). */
  onSearchKeyDown: (event: ReactKeyboardEvent) => void;
  /** Move keyboard focus into the listbox host. */
  focusList: () => void;
}

/**
 * Drive one filter dropdown: open/close lifecycle, an optional search filter, and
 * roving keyboard focus with Enter/Space activation. `onActivate` toggles (or
 * selects) the item; `closeOnActivate` is set for the single-select sort control
 * so a pick dismisses the panel, while the multi-selects stay open.
 */
export function useFilterDropdown<T extends string>(
  items: readonly T[],
  config: { onActivate: (item: T) => void; closeOnActivate?: boolean },
): UseFilterDropdown<T> {
  const { onActivate, closeOnActivate = false } = config;
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  // A stable per-instance id prefix so each option carries a unique DOM id the
  // listbox host can reference via aria-activedescendant.
  const baseId = useId();
  const optionId = useCallback((index: number) => `${baseId}-opt-${index}`, [baseId]);
  const activeDescendantId = focusedIndex >= 0 ? optionId(focusedIndex) : undefined;

  const filteredItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (q === '') return [...items];
    return items.filter((item) => item.toLowerCase().includes(q));
  }, [items, searchTerm]);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  // Close AND return DOM focus to the trigger — used by the in-panel close paths
  // (Escape, a single-select pick) so keyboard focus never drops to <body> when
  // the panel unmounts. Outside-click / tab-out deliberately do NOT restore
  // focus: there the user is already moving elsewhere.
  const closeAndFocusTrigger = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Reset the transient search + focus each time the panel closes, so it reopens
  // clean (matching the reference's onOpenChange reset).
  useEffect(() => {
    if (!open) {
      setSearchTerm('');
      setFocusedIndex(-1);
    }
  }, [open]);

  // Outside-click, Esc, and tab-out all close (the Menu primitive's discipline).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && !root.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // Esc originates from inside the panel — return focus to the trigger.
        closeAndFocusTrigger();
      }
    };
    const root = rootRef.current;
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next !== null && root !== null && !root.contains(next)) close();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    root?.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      root?.removeEventListener('focusout', onFocusOut);
    };
  }, [open, close, closeAndFocusTrigger]);

  // Keep the roving-focused option scrolled into view.
  useEffect(() => {
    if (focusedIndex >= 0) itemRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  // On open, land keyboard focus inside the panel — the search box when present
  // (searchable dropdowns render one), else the listbox nav host.
  useEffect(() => {
    if (!open) return;
    (searchInputRef.current ?? listRef.current)?.focus();
  }, [open]);

  const focusList = useCallback(() => {
    listRef.current?.focus();
    setFocusedIndex((prev) => (prev < 0 && filteredItems.length > 0 ? 0 : prev));
  }, [filteredItems.length]);

  const activateAt = useCallback(
    (index: number) => {
      const item = filteredItems[index];
      if (item === undefined) return;
      onActivate(item);
      // A single-select pick closes from inside the panel — return focus to the
      // trigger so the keyboard user keeps their place in the filter bar.
      if (closeOnActivate) closeAndFocusTrigger();
    },
    [filteredItems, onActivate, closeOnActivate, closeAndFocusTrigger],
  );

  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (filteredItems.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => (prev < filteredItems.length - 1 ? prev + 1 : 0));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) => (prev > 0 ? prev - 1 : filteredItems.length - 1));
          break;
        case 'Home':
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setFocusedIndex(filteredItems.length - 1);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (focusedIndex >= 0) activateAt(focusedIndex);
          break;
      }
    },
    [filteredItems.length, focusedIndex, activateAt],
  );

  // From the search box: ArrowDown hands off to the list; Enter activates the
  // current focus (or the first result) so a search-then-Enter picks a match.
  const onSearchKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        activateAt(focusedIndex >= 0 ? focusedIndex : 0);
      }
    },
    [focusList, activateAt, focusedIndex],
  );

  return {
    open,
    toggle,
    close,
    rootRef,
    triggerRef,
    listRef,
    searchInputRef,
    searchTerm,
    setSearchTerm,
    filteredItems,
    focusedIndex,
    optionId,
    activeDescendantId,
    itemRefs,
    onListKeyDown,
    onSearchKeyDown,
    focusList,
  };
}
