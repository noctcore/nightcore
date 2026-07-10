/** TerminalTabs helpers: pure derivations. The bar is stateless (data via props),
 *  so these are plain functions, not `use*` hooks. */
import { TERMINAL_SESSION_CAP } from '../terminal-shared';

/** Title for the new-tab button — explains the disabled state at the cap. */
export function newTabTitle(canAddTab: boolean): string {
  return canAddTab
    ? 'New terminal'
    : `Terminal limit reached (${TERMINAL_SESSION_CAP}) — close a tab first`;
}
