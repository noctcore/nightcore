/** TerminalTabs helpers: pure derivations. The bar is stateless (data via props),
 *  so these are plain functions, not `use*` hooks. */
import { TERMINAL_SESSION_CAP } from '../terminal-shared';

/** Title for the new-tab button — explains the disabled state at the cap. */
export function newTabTitle(canAddTab: boolean): string {
  return canAddTab
    ? 'New terminal'
    : `Terminal limit reached (${TERMINAL_SESSION_CAP}) — close a tab first`;
}

/** The unread-output badge text (decision 6c): the raw count, clamped so a busy
 *  background tab shows `99+` rather than an ever-widening pill. */
export function unreadBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Accessible label for the unread badge. */
export function unreadBadgeLabel(count: number): string {
  return `${count} unread output ${count === 1 ? 'batch' : 'batches'}`;
}
