import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { KeyEvent } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import type { SessionManager } from '@nightcore/engine';
import type {
  Config,
  EffortLevel,
  ModelDescriptor,
  PermissionMode,
} from '@nightcore/contracts';
import { useSession } from './useSession.js';
import { matchPalette } from './commands/palette.js';
import { SessionHeader } from './components/SessionHeader.js';
import { StreamView } from './components/StreamView.js';
import { InputBox } from './components/InputBox.js';
import type { InputBoxHandle } from './components/InputBox.js';
import { CommandPalette } from './components/CommandPalette.js';
import { TaskPanel, hasVisibleTasks } from './components/TaskPanel.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { ModelPicker } from './components/ModelPicker.js';
import { FooterHints } from './components/FooterHints.js';

interface AppProps {
  manager: SessionManager;
  config: Config;
  defaults: { model: string; permissionMode: PermissionMode };
}

/** The model-picker overlay: closed, loading the dynamic model list, or open
 *  with the fetched descriptors. */
type Picker =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'open'; models: ModelDescriptor[] };

/** True while the buffer is a bare slash-command name being typed — `/mod`, `/`
 *  — i.e. starts with `/` and has no whitespace yet (args end autocomplete). */
function isCommandPrefix(buffer: string): boolean {
  return buffer.startsWith('/') && !/\s/.test(buffer);
}

export function App({ manager, config, defaults }: AppProps): ReactNode {
  const renderer = useRenderer();
  const [picker, setPicker] = useState<Picker>({ state: 'closed' });
  const [buffer, setBuffer] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<InputBoxHandle | null>(null);

  const quit = useCallback(() => renderer.destroy(), [renderer]);

  // `/model` opens the picker: fetch the dynamic model list, then show it.
  const openModelPicker = useCallback(() => {
    setPicker({ state: 'loading' });
    void manager
      .listModels()
      .then((models) => setPicker({ state: 'open', models }))
      .catch(() => setPicker({ state: 'open', models: [] }));
  }, [manager]);

  const {
    view,
    submit,
    interrupt,
    togglePermissionMode,
    resolvePermission,
    selectModel,
    isBusy,
  } = useSession(manager, config, defaults, { openModelPicker, quit });

  const hasPermission = view.pendingPermission !== null;
  const pickerOpen = picker.state !== 'closed';

  // Autocomplete matches for the current buffer, recomputed on buffer / palette
  // change. Empty (and so the dropdown hidden) unless the buffer is a bare
  // `/command` prefix and at least one command matches.
  const matches = useMemo(
    () =>
      isCommandPrefix(buffer)
        ? matchPalette(view, buffer.slice(1))
        : [],
    [buffer, view],
  );
  const autocompleteOpen = matches.length > 0;

  // Reset the highlight whenever the match set changes shape so it never points
  // past the end. Clamp instead of resetting to 0 to keep the user's position
  // stable as they refine the prefix.
  const safeHighlight = highlighted < matches.length ? highlighted : 0;

  const onBufferChange = useCallback((text: string) => {
    setBuffer(text);
    setHighlighted(0);
  }, []);

  const allow = useCallback(
    () => resolvePermission({ behavior: 'allow' }),
    [resolvePermission],
  );
  const deny = useCallback(
    () =>
      resolvePermission({ behavior: 'deny', message: 'Denied by operator.' }),
    [resolvePermission],
  );

  const commitModel = useCallback(
    (model: string, effort: EffortLevel | null) => {
      selectModel(model, effort);
      setPicker({ state: 'closed' });
    },
    [selectModel],
  );

  /** Tab: write the highlighted command into the buffer (kept open for args). */
  const completeHighlighted = useCallback(() => {
    const entry = matches[safeHighlight];
    if (entry === undefined) return;
    inputRef.current?.setText(`/${entry.name} `);
  }, [matches, safeHighlight]);

  /** Enter while the dropdown is open: run the highlighted command and clear. */
  const runHighlighted = useCallback(() => {
    const entry = matches[safeHighlight];
    if (entry === undefined) return;
    submit(`/${entry.name}`);
    inputRef.current?.setText('');
  }, [matches, safeHighlight, submit]);

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.ctrl && key.name === 'c') {
          renderer.destroy();
          return;
        }
        // The picker is a modal overlay: Esc closes it; arrows/enter route to the
        // focused <select> inside it. Swallow everything else so it stays modal.
        if (pickerOpen) {
          if (key.name === 'escape') setPicker({ state: 'closed' });
          return;
        }
        // Slash autocomplete owns ↑/↓/Tab/Enter/Esc while it is open. These keys
        // reach here because (a) `useKeyboard` taps the raw key stream regardless
        // of focus and (b) InputBox releases the Enter→submit binding via
        // `suppressNav`, so Enter falls through instead of submitting the buffer.
        if (autocompleteOpen) {
          if (key.name === 'tab' && !key.shift) {
            completeHighlighted();
            return;
          }
          if (key.name === 'up') {
            setHighlighted(
              (i) => (i - 1 + matches.length) % matches.length,
            );
            return;
          }
          if (key.name === 'down') {
            setHighlighted((i) => (i + 1) % matches.length);
            return;
          }
          if (key.name === 'return' || key.name === 'kpenter') {
            runHighlighted();
            return;
          }
          if (key.name === 'escape') {
            // Dismiss the dropdown without touching the buffer: clear it so the
            // prefix no longer matches (simplest, and mirrors abandoning a /cmd).
            inputRef.current?.setText('');
            return;
          }
        }
        // Shift+Tab flips plan ↔ build at any time.
        if (key.name === 'tab' && key.shift) {
          togglePermissionMode();
          return;
        }
        // While a permission is pending the input is blurred, so y/n/esc route
        // straight to the approval decision instead of into the textarea.
        if (hasPermission) {
          if (key.name === 'y') allow();
          else if (key.name === 'n' || key.name === 'escape') deny();
          return;
        }
        if (key.name === 'escape') interrupt();
      },
      [
        renderer,
        pickerOpen,
        autocompleteOpen,
        matches.length,
        completeHighlighted,
        runHighlighted,
        togglePermissionMode,
        hasPermission,
        allow,
        deny,
        interrupt,
      ],
    ),
  );

  const showTaskPanel = hasVisibleTasks(view.tasks);

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      <SessionHeader view={view} />
      <StreamView transcript={view.transcript} />
      {showTaskPanel && <TaskPanel tasks={view.tasks} />}
      {picker.state === 'loading' && (
        <box
          title="/model"
          style={{ border: true, borderColor: '#5fafff', paddingLeft: 1 }}
        >
          <text fg="#777777">loading models…</text>
        </box>
      )}
      {picker.state === 'open' && (
        <ModelPicker
          models={picker.models}
          currentModel={view.model}
          onSelect={commitModel}
        />
      )}
      {view.pendingPermission !== null && (
        <PermissionPrompt request={view.pendingPermission} />
      )}
      {autocompleteOpen && (
        <CommandPalette entries={matches} highlighted={safeHighlight} />
      )}
      <InputBox
        ref={inputRef}
        focused={!hasPermission && !pickerOpen}
        busy={isBusy}
        suppressNav={autocompleteOpen}
        onChange={onBufferChange}
        onSubmit={submit}
      />
      <FooterHints busy={isBusy} mode={view.permissionMode} />
    </box>
  );
}
