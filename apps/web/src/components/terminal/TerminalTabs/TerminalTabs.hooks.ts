/** TerminalTabs helpers: pure derivations. The bar is stateless (data via props),
 *  so these are plain functions, not `use*` hooks. */
import { formatShortcut } from '../terminal-platform';
import { TERMINAL_SESSION_CAP } from '../terminal-shared';

/** Title for the new-tab button — carries the ⌘T hint (spec PR 3a) and explains the
 *  disabled state at the cap. */
export function newTabTitle(canAddTab: boolean): string {
  return canAddTab
    ? `New terminal (${formatShortcut('T')})`
    : `Terminal limit reached (${TERMINAL_SESSION_CAP}) — close a tab first`;
}
