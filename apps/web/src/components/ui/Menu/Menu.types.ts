import type { ReactElement, ReactNode } from 'react';

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
   *  Menu composes the open/close `onClick` onto it (preserving any existing
   *  handler) and injects `aria-haspopup`/`aria-expanded` for screen readers. */
  trigger: ReactElement<{
    onClick?: () => void;
    'aria-haspopup'?: 'menu';
    'aria-expanded'?: boolean;
  }>;
  /** Accessible name for the menu's listbox region. */
  label: string;
  items: MenuItem[];
  /** Horizontal anchor edge for the popover. Defaults to `right`. */
  align?: 'left' | 'right';
}
