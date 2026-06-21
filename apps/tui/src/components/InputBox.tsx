import { useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { TextareaOptions, TextareaRenderable } from '@opentui/core';

/** The textarea's own keybinding shape (action constrained to `TextareaAction`).
 *  Sourced from the options type so it stays correct if the API shifts. */
type TextareaKeyBindings = NonNullable<TextareaOptions['keyBindings']>;

interface InputBoxProps {
  focused: boolean;
  busy: boolean;
  onSubmit: (text: string) => void;
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
 */
export function InputBox({
  focused,
  busy,
  onSubmit,
}: InputBoxProps): ReactNode {
  const ref = useRef<TextareaRenderable | null>(null);

  const keyBindings = useMemo<TextareaKeyBindings>(
    () => [
      // Plain Enter / numpad Enter → submit (overrides the default newline).
      { name: 'return', action: 'submit' },
      { name: 'kpenter', action: 'submit' },
      // Shift+Enter → newline (the multi-line escape hatch).
      { name: 'return', shift: true, action: 'newline' },
      { name: 'kpenter', shift: true, action: 'newline' },
    ],
    [],
  );

  const handleSubmit = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    const text = node.plainText;
    if (text.trim().length === 0) return;
    onSubmit(text);
    node.clear();
  }, [onSubmit]);

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
        />
      </box>
    </box>
  );
}
