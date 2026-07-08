/** Open/close, focus, and keyboard behavior for {@link Menu}. */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MenuItem } from './Menu.types';

export function useMenu(items: MenuItem[]) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => setOpen(false), []);
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    // Tab-out: close when focus leaves the menu so a keyboard user never ends up
    // on a control behind the still-open panel. Focus has already moved on to
    // `relatedTarget`, so we let it go rather than trap it; a null relatedTarget
    // (focus lost to nothing) is left to the outside-pointerdown handler.
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
  }, [open, close]);

  // Focus the first item when the menu opens (keyboard entry point).
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const onItemKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        itemRefs.current[(index + 1) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        itemRefs.current[(index - 1 + items.length) % items.length]?.focus();
      }
    },
    [items.length],
  );

  const select = useCallback(
    (item: MenuItem) => {
      close();
      item.onClick();
    },
    [close],
  );

  return {
    open,
    rootRef,
    itemRefs,
    close,
    select,
    onItemKeyDown,
    toggleOpen,
  };
}
