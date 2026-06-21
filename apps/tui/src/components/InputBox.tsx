import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import type { ForwardedRef, ReactNode } from 'react';
import type { TextareaOptions, TextareaRenderable } from '@opentui/core';

/** The textarea's own keybinding shape (action constrained to `TextareaAction`).
 *  Sourced from the options type so it stays correct if the API shifts. */
type TextareaKeyBindings = NonNullable<TextareaOptions['keyBindings']>;

/** Imperative handle App uses to complete a `/command` into the buffer when Tab
 *  is pressed with the autocomplete open. */
export interface InputBoxHandle {
  /** Replace the buffer with `text` (cursor moves to the end) and lift the new
   *  value so the autocomplete match recomputes. */
  setText: (text: string) => void;
}

interface InputBoxProps {
  focused: boolean;
  busy: boolean;
  onSubmit: (text: string) => void;
  /** Called whenever the buffer changes, with its current plain text — App uses
   *  it to drive the slash-command autocomplete. */
  onChange: (text: string) => void;
  /** When true, the textarea releases the `↑`/`↓`/`Enter` bindings so those keys
   *  fall through to App's global handler to drive the autocomplete dropdown
   *  (the focused renderable would otherwise consume them first). */
  suppressNav: boolean;
}

/**
 * Multi-line prompt input. **Enter submits, Shift+Enter inserts a newline.**
 *
 * OpenTUI's `<textarea>` ships defaults that do the opposite — plain `return`
 * is bound to the `newline` action and only `meta`(Alt)+`return` submits, with
 * no Shift+Enter binding at all. The textarea consumes any key whose binding
 * matches (its `handleKeyPress` returns `true`), so we can't suppress the native
 * newline from a global `useKeyboard` handler — the focused renderable sees the
 * key first.
 *
 * The deterministic fix is to own the bindings. `TextareaOptions.keyBindings`
 * are merged over the defaults by a `name:ctrl:shift:meta:super` key
 * (`mergeKeyBindings`), so a custom `{ name: 'return', action: 'submit' }`
 * REPLACES the default `{ name: 'return', action: 'newline' }` (same key), while
 * `{ name: 'return', shift: true, action: 'newline' }` adds Shift+Enter. With
 * `return` (and the numpad `kpenter`) rebound to `submit`, a plain Enter fires
 * `onSubmit` and never inserts a newline; Shift+Enter inserts one as expected.
 *
 * Autocomplete key routing reuses the same understanding. The textarea's
 * `handleKeyPress` only consumes a key when a binding maps it to an action; ↑/↓
 * are bound to `move-up`/`move-down` and `return` to `submit`. When the slash
 * autocomplete is open (`suppressNav`), we DROP those three bindings, so the
 * textarea returns `false` for ↑/↓/Enter (they are control chars, not printable)
 * and the keys fall through to App's global `useKeyboard`, which drives the
 * dropdown. Tab is never a textarea action, so it always reaches App.
 */
function InputBoxInner(
  { focused, busy, onSubmit, onChange, suppressNav }: InputBoxProps,
  forwardedRef: ForwardedRef<InputBoxHandle>,
): ReactNode {
  const ref = useRef<TextareaRenderable | null>(null);

  useImperativeHandle(
    forwardedRef,
    () => ({
      setText: (text: string) => {
        const node = ref.current;
        if (node === null) return;
        node.setText(text);
        onChange(node.plainText);
      },
    }),
    [onChange],
  );

  const keyBindings = useMemo<TextareaKeyBindings>(() => {
    const bindings: TextareaKeyBindings = [
      // Shift+Enter → newline (the multi-line escape hatch). Always bound.
      { name: 'return', shift: true, action: 'newline' },
      { name: 'kpenter', shift: true, action: 'newline' },
    ];
    if (!suppressNav) {
      // Plain Enter / numpad Enter → submit (overrides the default newline).
      // Dropped while the autocomplete is open so Enter runs the highlighted
      // command via App instead of submitting the raw buffer.
      bindings.push(
        { name: 'return', action: 'submit' },
        { name: 'kpenter', action: 'submit' },
      );
    }
    // ↑/↓ keep their default cursor-movement bindings even while the dropdown is
    // open: `useKeyboard` subscribes straight to the raw key stream, so App's
    // handler fires for ↑/↓ regardless of what the focused textarea does, and
    // moving the cursor inside a one-line `/command` buffer is a no-op anyway.
    // Only Enter must be released (above) so it runs the highlighted command
    // instead of submitting the raw buffer.
    return bindings;
  }, [suppressNav]);

  const handleSubmit = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    const text = node.plainText;
    if (text.trim().length === 0) return;
    onSubmit(text);
    node.clear();
    onChange('');
  }, [onSubmit, onChange]);

  const handleContentChange = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    onChange(node.plainText);
  }, [onChange]);

  return (
    <box style={{ flexDirection: 'column' }}>
      <box
        title={busy ? 'follow-up' : 'prompt'}
        style={{
          border: true,
          borderColor: focused ? '#5fafff' : '#333344',
          height: 5,
        }}
      >
        <textarea
          ref={ref}
          focused={focused}
          placeholder={busy ? 'Send more input…' : 'Ask Nightcore anything…'}
          keyBindings={keyBindings}
          onSubmit={handleSubmit}
          onContentChange={handleContentChange}
        />
      </box>
    </box>
  );
}

export const InputBox = forwardRef(InputBoxInner);
