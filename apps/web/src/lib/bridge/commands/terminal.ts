/** Bridge commands — the USER terminal (PTY) seam.
 *
 *  Lifecycle (`terminal_spawn` / `write` / `resize` / `kill` / `list` /
 *  `sessions_in_dir`) rides `invoke`; the shell's OUTPUT does NOT — it streams
 *  over a per-session binary `tauri::ipc::Channel` passed to `terminal_spawn`.
 *  Each coalesced batch arrives as an `ArrayBuffer` on the Channel's message
 *  handler (Rust sends `InvokeResponseBody::Raw` — never JSON), which we hand to
 *  the caller as a `Uint8Array` for `term.write()`.
 *
 *  This is the single place the terminal touches `@tauri-apps/api` (the bridge is
 *  the only module allowed to). Outside the webview every call degrades to the
 *  in-memory echo (`../mocks`) so Storybook / component tests / `dogfood:ui`
 *  render a live-feeling terminal without a real PTY.
 *
 *  `@tauri-apps/api/core` (`Channel`/`invoke`) is loaded via DYNAMIC import inside
 *  the `isTauri()` branches — NOT a top-level import — so this module (pulled by
 *  the whole `@/lib/bridge` barrel) never statically drags the Tauri core into
 *  every bridge consumer's graph. That kept the vitest browser dep-optimizer from
 *  re-bundling mid-run and 404-ing in-flight module URLs (the known re-optimize
 *  flake). The dynamic import only ever runs inside the real webview. */
import { isTauri, tauriInvoke } from '../internal';
import {
  echoKillTerminal,
  echoSpawnTerminal,
  echoWriteTerminal,
  type TerminalByteHandler,
} from '../mocks';
import type {
  PersistedTerminalInfo,
  PersistedTerminalScrollback,
  TerminalDaemonStatus,
  TerminalSessionInfo,
  WorktreeInfo,
} from '../types';

export type { TerminalByteHandler } from '../mocks';

/** The knobs a spawn needs. `confined` is always `false` in PR B (unconfined
 *  default — the opt-in Seatbelt toggle is PR C); it rides the wire now so the
 *  contract is stable. */
export interface SpawnTerminalOpts {
  /** Absolute cwd — the picked worktree path or the repo root. Re-validated +
   *  confined to the project server-side (the webview's value is never trusted). */
  cwd: string;
  /** Opt-in Seatbelt write-containment (macOS only). Always `false` in PR B. */
  confined: boolean;
  cols: number;
  rows: number;
}

/** A live session subscription: the server descriptor plus a `detach` that stops
 *  delivering output to the byte handler. `detach` does NOT kill the shell —
 *  call {@link killTerminal} for that. */
export interface TerminalHandle {
  session: TerminalSessionInfo;
  detach: () => void;
}

/** Spawn a shell in `opts.cwd` and stream its coalesced output to `onData` as raw
 *  byte frames. Rejects when the live-session cap (8) is exceeded or the cwd is
 *  rejected server-side — the caller surfaces that as a toast/inline message. */
export async function spawnTerminal(
  opts: SpawnTerminalOpts,
  onData: TerminalByteHandler,
): Promise<TerminalHandle> {
  if (!isTauri()) return echoSpawnTerminal(opts, onData);
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  // A dedicated ordered binary stream per session. Rust sends `Raw(Vec<u8>)`,
  // which the Channel surfaces as an ArrayBuffer — no JSON, no base64.
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
  const session = await invoke<TerminalSessionInfo>('terminal_spawn', {
    cwd: opts.cwd,
    confined: opts.confined,
    cols: opts.cols,
    rows: opts.rows,
    channel,
  });
  return {
    session,
    // Silence the handler so a late frame after unmount can't write into a
    // disposed xterm (the channel itself is GC'd with this closure).
    detach: () => {
      channel.onmessage = () => {};
    },
  };
}

/** Reattach to an EXISTING live session and stream its output to `onData` (cockpit
 *  spec PR 6 — detached-daemon reattach on relaunch). Mirrors {@link spawnTerminal}
 *  but calls `terminal_attach` (no new shell): the daemon replays the session's
 *  buffered output tail then streams live, all onto the SAME per-session binary
 *  Channel the shipped code consumes. The caller invokes this only for a session
 *  `listTerminals()` reported live but with no local xterm instance (the post-restart
 *  case). Rejects when there is no such live session (no daemon / already exited) —
 *  the caller then read-only-restores. No-op-rejects outside Tauri (the echo has no
 *  daemon). Dynamic import per the bridge's Tauri-core isolation rule (§9 trap f). */
export async function attachTerminal(
  id: string,
  onData: TerminalByteHandler,
): Promise<TerminalHandle> {
  if (!isTauri()) throw new Error('terminal reattach is unavailable outside the desktop app');
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buffer) => onData(new Uint8Array(buffer));
  const session = await invoke<TerminalSessionInfo>('terminal_attach', { id, channel });
  return {
    session,
    detach: () => {
      channel.onmessage = () => {};
    },
  };
}

/** The detached-PTY-daemon status (cockpit spec PR 6): whether the experimental
 *  live-PTY-survival daemon is enabled, supported on this platform, and currently
 *  live. Informational only (the backend degrades on its own regardless). Outside
 *  Tauri it reports "not supported" so the Settings toggle renders its inert state. */
export async function terminalDaemonStatus(): Promise<TerminalDaemonStatus> {
  return tauriInvoke<TerminalDaemonStatus>('terminal_daemon_status', {}, {
    enabled: false,
    supported: false,
    active: false,
  });
}

/** Forward user input bytes (xterm `onData`) to a session's shell. Sent as a
 *  plain number array so it deserializes to Rust's `Vec<u8>` unambiguously;
 *  keystrokes/pastes are small enough that the copy is free. */
export async function writeTerminal(id: string, data: Uint8Array): Promise<void> {
  if (!isTauri()) {
    echoWriteTerminal(id, data);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('terminal_write', { id, data: Array.from(data) });
}

/** Set (or clear, with `null`) a session's manual tab name (decision 5). The
 *  server trims + treats blank as "clear", and persists the name so it survives a
 *  read-only restore. No-op outside Tauri — the caller's optimistic local update
 *  still renames the echo tab in Storybook / `dogfood:ui`. Dynamic import per the
 *  bridge's Tauri-core isolation rule. */
export async function setTerminalTitle(id: string, title: string | null): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('terminal_set_title', { id, title });
}

/** Create a user-driven terminal worktree from the new-tab picker (spec PR 5a): slug the
 *  `name` server-side, allocate a worktree under the separate `term/` namespace (a new
 *  `term/<slug>` branch off `base` when `createBranch`, else a detached checkout at
 *  `base`), and return its `WorktreeInfo` — the picker then spawns a terminal into its
 *  `path`. Rejects on a real failure (bad name, git error) so the dialog can surface it.
 *  Dynamic import per the bridge's Tauri-core isolation rule (§9 trap f). Outside Tauri it
 *  fabricates a plausible worktree so Storybook / `dogfood:ui` open an echo tab. */
export async function terminalCreateWorktree(
  name: string,
  createBranch: boolean,
  base: string | null,
): Promise<WorktreeInfo> {
  if (!isTauri()) {
    // Echo mode: a synthetic worktree under a fake project so the echo spawn opens.
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
    return {
      branch: `term/${slug}`,
      path: `/echo/.nightcore/worktrees-term/${slug}`,
      taskIds: [],
      dirty: false,
      aheadOfBase: 0,
      behindOfBase: 0,
      changedFiles: 0,
    };
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<WorktreeInfo>('terminal_create_worktree', {
    name,
    createBranch,
    base: base ?? null,
  });
}

/** Resize a session's PTY (fit addon + ResizeObserver → SIGWINCH). No-op outside
 *  Tauri (the echo has no geometry). */
export async function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  await tauriInvoke<void>('terminal_resize', { id, cols, rows }, undefined);
}

/** Terminate a session (idempotent). */
export async function killTerminal(id: string): Promise<void> {
  if (!isTauri()) {
    echoKillTerminal(id);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('terminal_kill', { id });
}

/** All live sessions — the tab list. Returns `[]` outside Tauri. */
export async function listTerminals(): Promise<TerminalSessionInfo[]> {
  return tauriInvoke<TerminalSessionInfo[]>('terminal_list', {}, []);
}

/** Live sessions whose cwd is `path` or under it — the cleanup-confirm seam the
 *  worktree merge/discard dialogs gate on. Returns `[]` outside Tauri, so those
 *  flows default to "no open sessions" (no blocking notice). */
export async function terminalSessionsInDir(
  path: string,
): Promise<TerminalSessionInfo[]> {
  return tauriInvoke<TerminalSessionInfo[]>('terminal_sessions_in_dir', { path }, []);
}

// --- Restore on relaunch (PR C) -------------------------------------------
//
// Dead sessions persist their scrollback to `.nightcore/terminals/<id>.json`; on
// Terminal view mount the restore UI lists them and replays a selected one's
// scrollback READ-ONLY, with a "start a fresh shell here" action. These commands
// carry only small JSON descriptors (no Channel — the replay bytes ride the
// base64 field of `terminal_read_persisted`), so they go through `tauriInvoke`
// like the other lifecycle reads. Outside Tauri there is no persistence, so the
// list is empty and the reads degrade to no-ops.

/** Persisted (dead) sessions' metadata for the restore UI, newest first. The Rust
 *  side prunes stale files (age + vanished cwd) as a side effect of listing.
 *  Returns `[]` outside Tauri (browser preview / dogfood → no restored tabs). */
export async function listTerminalsPersisted(): Promise<PersistedTerminalInfo[]> {
  return tauriInvoke<PersistedTerminalInfo[]>('terminal_list_persisted', {}, []);
}

/** A persisted session's metadata + scrollback bytes (base64) for read-only
 *  replay. Outside Tauri this is never reached in the normal flow (the list is
 *  empty), so it resolves to an empty replay. */
export async function readTerminalPersisted(
  id: string,
): Promise<PersistedTerminalScrollback> {
  return tauriInvoke<PersistedTerminalScrollback>('terminal_read_persisted', { id }, {
    info: { id, cwd: '', shell: '', confined: false, createdAt: 0, updatedAt: 0, title: null },
    dataBase64: '',
  });
}

/** Delete a persisted session's scrollback file — the restore UI's "dismiss", so a
 *  dismissed read-only tab does not reappear on the next relaunch. Idempotent;
 *  no-ops outside Tauri. */
export async function deleteTerminalPersisted(id: string): Promise<void> {
  await tauriInvoke<void>('terminal_delete_persisted', { id }, undefined);
}
