/** Accessible dropdown menu anchored to a trigger element. */
import { cloneElement, isValidElement } from 'react';

import { AnimatePresence, m, popover } from '../motion';
import { useMenu } from './Menu.hooks';
import type { MenuItem, MenuProps } from './Menu.types';

/** A small accessible dropdown menu anchored to its trigger. Opens on trigger
 *  click; closes on outside-click, Esc, or item selection. Arrow keys move
 *  focus between items; Enter/Space activate. Reusable across surfaces. */
export function Menu({ trigger, label, items, align = 'right' }: MenuProps) {
  const { open, rootRef, itemRefs, select, onItemKeyDown, toggleOpen } = useMenu(items);

  const triggerNode = isValidElement(trigger)
    ? cloneElement(trigger, {
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        // Compose, don't clobber: fire the trigger's own onClick before toggling.
        onClick: () => {
          trigger.props.onClick?.();
          toggleOpen();
        },
      })
    : trigger;

  return (
    <div ref={rootRef} className="relative inline-flex">
      {triggerNode}
      <AnimatePresence>
        {open && (
          <m.div
            role="menu"
            aria-label={label}
            variants={popover}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{ transformOrigin: align === 'right' ? 'top right' : 'top left' }}
            className={`absolute top-full z-20 mt-1 min-w-[160px] overflow-hidden rounded-[10px] border border-border bg-popover py-1 shadow-2xl ${
              align === 'right' ? 'right-0' : 'left-0'
            }`}
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
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
                  item.destructive
                    ? 'text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10'
                    : 'text-foreground hover:bg-white/[0.06] focus-visible:bg-white/[0.12]'
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
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export type { MenuItem, MenuProps };
