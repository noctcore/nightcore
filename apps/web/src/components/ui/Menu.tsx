/** Accessible dropdown menu anchored to a trigger element. */
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/** A single selectable row in a {@link Menu}. */
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Render the item in the destructive (red) tone. */
  destructive?: boolean;
}

/** Props for {@link Menu}. */
export interface MenuProps {
  /** The trigger — a single interactive element (typically an IconButton). The
   *  Menu injects the open/close `onClick` onto it. */
  trigger: ReactElement<{ onClick?: () => void }>;
  /** Accessible name for the menu's listbox region. */
  label: string;
  items: MenuItem[];
  /** Horizontal anchor edge for the popover. Defaults to `right`. */
  align?: 'left' | 'right';
}

/** A small accessible dropdown menu anchored to its trigger. Opens on trigger
 *  click; closes on outside-click, Esc, or item selection. Arrow keys move
 *  focus between items; Enter/Space activate. Reusable across surfaces. */
export function Menu({ trigger, label, items, align = 'right' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => setOpen(false), []);

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
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
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

  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger, { onClick: () => setOpen((v) => !v) })
    : trigger;

  return (
    <div ref={rootRef} className="relative inline-flex">
      {triggerNode}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-[10px] border border-border bg-popover py-1 shadow-2xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          style={{ animation: 'nc-rise .14s cubic-bezier(.22,1,.36,1)' }}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              onClick={() => select(item)}
              onKeyDown={(e) => onItemKeyDown(e, index)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.12] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                item.destructive
                  ? 'text-destructive hover:text-destructive'
                  : 'text-foreground'
              }`}
            >
              {item.icon !== undefined && (
                <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
