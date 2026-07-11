/** True when the event target is a text-entry surface where a bare keypress is real
 *  typing, not a shortcut — an input, textarea, select, or any contenteditable host.
 *  Shared by the global keyboard layers (nav + board shortcuts) so a hotkey never
 *  steals a keystroke while the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}
