/** State/effects for the {@link TerminalSearchBar}: autofocus the input on open and
 *  map Enter / Shift+Enter / Esc to next / prev / close (the `.tsx` stays a thin
 *  shell — no refs/effects in the component body). */
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef } from 'react';

/** What the search bar binds to. */
export interface TerminalSearchBarView {
  /** Ref for the query input — focused + select-all'd on open (avoids `autoFocus`). */
  readonly inputRef: RefObject<HTMLInputElement | null>;
  /** Keydown handler for the input: Enter → next, Shift+Enter → prev, Esc → close. */
  readonly onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** Drive the find bar's input focus + key handling. */
export function useTerminalSearchBar({
  onNext,
  onPrev,
  onClose,
}: {
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}): TerminalSearchBarView {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the query on open (the bar mounts only while search is active).
  useEffect(() => {
    const el = inputRef.current;
    if (el !== null) {
      el.focus();
      el.select();
    }
  }, []);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) onPrev();
        else onNext();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [onNext, onPrev, onClose],
  );

  return { inputRef, onInputKeyDown };
}
