import { useMemo } from 'react';

import { NAV_GROUP_META } from '../NavSidebar/NavSidebar.hooks';
import type { ShortcutGroup, ShortcutSheetProps } from './ShortcutSheet.types';

/** The non-nav shortcut blocks. These MIRROR the real keyboard layers, so keep them
 *  in step with their owners:
 *   - Board: `AppShell/hooks/useBoardShortcuts.hooks.ts` (N / `/` / Esc).
 *   - Dialogs: `components/ui/Modal/Modal.hooks.ts` — the house rule is that a
 *     confirmation fires on ⌘/Ctrl+Enter only, never on bare Enter.
 *   - Help: `AppShell/hooks/useShortcutSheet.hooks.ts` (this sheet's own key). */
const STATIC_GROUPS: readonly ShortcutGroup[] = [
  {
    label: 'Board',
    note: 'While the Kanban board is on screen with no dialog open.',
    rows: [
      { keys: ['N'], label: 'New task' },
      { keys: ['/'], label: 'Focus the board search' },
      { keys: ['Esc'], label: 'Close the open task drawer' },
    ],
  },
  {
    label: 'Dialogs',
    rows: [
      { keys: ['⌘', '↵'], label: 'Confirm', context: 'Ctrl+↵ on Windows/Linux' },
      { keys: ['Esc'], label: 'Cancel and close' },
    ],
  },
  {
    label: 'Help',
    rows: [{ keys: ['?'], label: 'Open (or close) this sheet' }],
  },
];

/** The sheet's blocks. The "Go to" block is derived from the live nav rows — each
 *  row's single-letter hint IS its shortcut (`useNavShortcuts` reads the same list),
 *  and each row is captioned with the stage it belongs to, so the sheet doubles as a
 *  reminder of the five-stage lifecycle rather than a bare key table. */
export function useShortcutGroups(nav: ShortcutSheetProps['nav']): readonly ShortcutGroup[] {
  return useMemo(() => {
    const goTo: ShortcutGroup = {
      label: 'Go to',
      note: 'Single keys — active while a project is open and you are not typing.',
      rows: nav.map((item) => {
        const group = NAV_GROUP_META[item.group];
        return {
          keys: [item.hint],
          label: item.label,
          context:
            group.explainer !== undefined ? `${group.label} stage` : group.label,
        };
      }),
    };
    return [goTo, ...STATIC_GROUPS];
  }, [nav]);
}
