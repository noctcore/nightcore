import { useCallback, useState } from 'react';
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
import { SessionHeader } from './components/SessionHeader.js';
import { StreamView } from './components/StreamView.js';
import { InputBox } from './components/InputBox.js';
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

export function App({ manager, config, defaults }: AppProps): ReactNode {
  const renderer = useRenderer();
  const [picker, setPicker] = useState<Picker>({ state: 'closed' });

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
        togglePermissionMode,
        hasPermission,
        allow,
        deny,
        interrupt,
      ],
    ),
  );

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      <SessionHeader view={view} />
      <StreamView transcript={view.transcript} />
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
      <InputBox
        focused={!hasPermission && !pickerOpen}
        busy={isBusy}
        onSubmit={submit}
      />
      <FooterHints busy={isBusy} mode={view.permissionMode} />
    </box>
  );
}
