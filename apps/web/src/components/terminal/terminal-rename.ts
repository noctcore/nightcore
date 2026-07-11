/**
 * The shared inline-rename interaction for the Terminal feature (decision 5): a
 * double-click on a tab label or the pane's identity title swaps the text for a
 * controlled input — Enter saves, Esc cancels, blur saves. Lives at the feature
 * root (a domain hook, not a component) so BOTH the tab (`TerminalTabs`) and the
 * pane header (`TerminalPane`) drive the exact same edit semantics without
 * duplicating the fiddly commit/cancel/blur guard.
 *
 * Rename is MANUAL only (no AI auto-naming in v1). An empty/whitespace commit
 * clears the name back to the cwd-leaf fallback; the caller (and the Rust
 * `terminal_set_title`) normalize blanks to "unset".
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** Handlers + state a rename-capable label binds to. The consumer renders a plain
 *  text element (double-click → {@link begin}) or, while {@link editing}, a
 *  controlled `<input>` wired to the returned change/key/blur handlers. */
export interface InlineRename {
  /** Whether the input is currently shown. */
  readonly editing: boolean;
  /** The controlled input value. */
  readonly draft: string;
  /** Ref for the edit `<input>` — focused + select-all'd on entering edit mode
   *  (avoids the a11y-discouraged `autoFocus` prop). */
  readonly inputRef: RefObject<HTMLInputElement | null>;
  /** Enter edit mode, seeding the draft from the current display title. */
  readonly begin: () => void;
  /** Controlled-input change handler. */
  readonly onChange: (event: { target: { value: string } }) => void;
  /** Key handler: Enter saves, Esc cancels (both suppress the default). */
  readonly onKeyDown: (event: {
    key: string;
    preventDefault: () => void;
  }) => void;
  /** Blur handler: saves the draft (unless a key already finished the edit). */
  readonly onBlur: () => void;
}

/**
 * Drive an inline rename over `current` (the resolved display title), calling
 * `onCommit` with the trimmed new value only when it actually changed. Enter and
 * Esc set a one-shot guard so the trailing blur they trigger does not re-commit
 * (Esc must not save the abandoned draft; Enter must not double-save).
 */
export function useInlineRename(
  current: string,
  onCommit: (next: string) => void,
): InlineRename {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // True while a key handler (Enter/Esc) has already resolved the edit, so the
  // blur it triggers by unmounting the input is a no-op.
  const settledByKey = useRef(false);

  // Focus + select the input when edit mode opens (replaces the a11y-flagged
  // `autoFocus` prop). Runs only on the false→true transition.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (el !== null) {
      el.focus();
      el.select();
    }
  }, [editing]);

  const finish = useCallback(
    (save: boolean) => {
      if (save) {
        const next = draft.trim();
        if (next !== current.trim()) onCommit(next);
      }
      setEditing(false);
    },
    [draft, current, onCommit],
  );

  const begin = useCallback(() => {
    settledByKey.current = false;
    setDraft(current);
    setEditing(true);
  }, [current]);

  const onChange = useCallback((event: { target: { value: string } }) => {
    setDraft(event.target.value);
  }, []);

  const onKeyDown = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        settledByKey.current = true;
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        settledByKey.current = true;
        finish(false);
      }
    },
    [finish],
  );

  const onBlur = useCallback(() => {
    if (settledByKey.current) {
      settledByKey.current = false;
      return;
    }
    finish(true);
  }, [finish]);

  return { editing, draft, inputRef, begin, onChange, onKeyDown, onBlur };
}
