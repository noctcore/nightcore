import { useCallback, useEffect, useRef, useState } from 'react';

/** Context-menu open state + position for {@link ProjectContextMenu}. */
export function useProjectContextMenu() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [close, open]);

  const openAt = useCallback((x: number, y: number) => {
    setPos({ x, y });
    setOpen(true);
  }, []);

  return { open, pos, menuRef, close, openAt };
}
