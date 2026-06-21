import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { SessionManager } from '@nightcore/engine';
import type {
  Config,
  EffortLevel,
  PermissionDecision,
  PermissionMode,
} from '@nightcore/contracts';
import { initialView, reduce } from './session-reducer.js';
import type { SessionView } from './types.js';
import { parseSlash } from './commands/parse.js';
import { runCommand } from './commands/registry.js';
import type { CommandContext } from './commands/types.js';

/** Surface hooks the command runner needs but that live in `App` (overlay state
 *  and the renderer). Passed down so `useSession` can build a `CommandContext`. */
export interface SurfaceHandlers {
  openModelPicker: () => void;
  quit: () => void;
}

export interface SessionApi {
  view: SessionView;
  /** Start a new session, send follow-up input, or run a slash command. */
  submit: (text: string) => void;
  /** Interrupt the live session. */
  interrupt: () => void;
  /** Flip plan ↔ build; returns the mode it switched to. */
  togglePermissionMode: () => void;
  /** Respond to the pending permission request. */
  resolvePermission: (decision: PermissionDecision) => void;
  /** Apply a model (and optional effort) chosen in the `/model` picker. */
  selectModel: (model: string, effort: EffortLevel | null) => void;
  /** True while a session is live (not idle and not in a terminal state). */
  isBusy: boolean;
}

/** plan = read-only; build = auto-accept edits. The two daily-driver modes. */
const PLAN: PermissionMode = 'plan';
const BUILD: PermissionMode = 'acceptEdits';

/**
 * The single engine-subscription hook. Owns a reducer over the `NightcoreEvent`
 * stream and exposes typed command dispatchers. The TUI is otherwise a pure view
 * over `view` — every engine mutation routes back through a `SurfaceCommand`, and
 * every surface-only mutation (mode/model echo, transcript output) through a
 * `ui-*` action.
 */
export function useSession(
  manager: SessionManager,
  config: Config,
  defaults: { model: string; permissionMode: PermissionMode },
  surface: SurfaceHandlers,
): SessionApi {
  const [view, dispatch] = useReducer(reduce, defaults, (d) =>
    initialView(d.model, d.permissionMode, config.effort ?? null),
  );

  useEffect(() => manager.on(dispatch), [manager]);

  const startOrSend = useCallback(
    (text: string) => {
      // Echo the operator's own prompt — the engine stream never does — BEFORE
      // the assistant response that follows.
      dispatch({ type: 'ui-user-message', text });
      if (view.sessionId === null || isTerminal(view.status)) {
        void manager.dispatch({
          type: 'start-session',
          prompt: text,
          model: view.model,
          // Effort is fixed at session start (no live setter); the picker's
          // choice therefore applies to whichever session starts next.
          effort: view.effort ?? undefined,
          permissionMode: view.permissionMode,
        });
      } else {
        void manager.dispatch({
          type: 'send-input',
          sessionId: view.sessionId,
          text,
        });
      }
    },
    [
      manager,
      view.sessionId,
      view.status,
      view.model,
      view.effort,
      view.permissionMode,
    ],
  );

  // A stable-enough context for the command runner. Rebuilt when its reads
  // change; `dispatch`/`manager`/`surface` are themselves stable.
  const commandCtx = useMemo<CommandContext>(
    () => ({
      view,
      config,
      manager,
      dispatch,
      openModelPicker: surface.openModelPicker,
      quit: surface.quit,
      forwardPrompt: startOrSend,
    }),
    [view, config, manager, surface, startOrSend],
  );

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      const slash = parseSlash(trimmed);
      if (slash !== null) {
        void runCommand(commandCtx, slash.name, slash.args);
        return;
      }

      startOrSend(trimmed);
    },
    [commandCtx, startOrSend],
  );

  const interrupt = useCallback(() => {
    if (view.sessionId === null || isTerminal(view.status)) return;
    void manager.dispatch({ type: 'interrupt', sessionId: view.sessionId });
  }, [manager, view.sessionId, view.status]);

  const togglePermissionMode = useCallback(() => {
    const next = view.permissionMode === PLAN ? BUILD : PLAN;
    // No engine event mirrors a mode change, so echo it locally regardless (so a
    // not-yet-started session still shows the choice in the header).
    dispatch({ type: 'ui-set-mode', mode: next });
    if (view.sessionId !== null && !isTerminal(view.status)) {
      void manager.dispatch({
        type: 'set-permission-mode',
        sessionId: view.sessionId,
        mode: next,
      });
    }
  }, [manager, view.permissionMode, view.sessionId, view.status]);

  const selectModel = useCallback(
    (model: string, effort: EffortLevel | null) => {
      // Update the surface defaults (model + effort for the next session)…
      dispatch({ type: 'ui-set-model', model, effort });
      // …and switch the live model immediately if a session is running. Effort
      // has no live setter, so it only takes effect on the next session.
      if (view.sessionId !== null && !isTerminal(view.status)) {
        void manager.dispatch({
          type: 'set-model',
          sessionId: view.sessionId,
          model,
        });
      }
    },
    [manager, view.sessionId, view.status],
  );

  const resolvePermission = useCallback(
    (decision: PermissionDecision) => {
      const pending = view.pendingPermission;
      if (pending === null || view.sessionId === null) return;
      void manager.dispatch({
        type: 'approve-permission',
        sessionId: view.sessionId,
        requestId: pending.requestId,
        decision,
      });
      dispatch({ type: 'ui-permission-resolved' });
    },
    [manager, view.pendingPermission, view.sessionId],
  );

  return {
    view,
    submit,
    interrupt,
    togglePermissionMode,
    resolvePermission,
    selectModel,
    isBusy: view.sessionId !== null && !isTerminal(view.status),
  };
}

function isTerminal(status: SessionView['status']): boolean {
  return (
    status === 'idle' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'interrupted'
  );
}
