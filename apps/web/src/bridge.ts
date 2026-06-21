import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** True when running inside the Tauri webview (vs. a plain browser preview). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** The subset of the engine's `NightcoreEvent` the M0 UI renders. The Rust core
 *  forwards each event verbatim over the `nc:event` channel. */
export type NcEvent =
  | {
      type: 'session-started';
      sessionId: number;
      model: string;
      permissionMode: string;
    }
  | { type: 'session-ready'; sessionId: number; sdkSessionId: string; model: string }
  | { type: 'assistant-delta'; sessionId: number; text: string; partial: boolean }
  | {
      type: 'tool-use-requested';
      sessionId: number;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: 'tool-result'; sessionId: number; isError: boolean; content: string }
  | { type: 'permission-required'; sessionId: number; toolName: string }
  | {
      type: 'session-completed';
      sessionId: number;
      costUsd: number;
      numTurns: number;
      durationMs: number;
    }
  | { type: 'session-failed'; sessionId: number; reason: string; message: string }
  | { type: 'session-status'; sessionId: number; status: string };

/** Run one prompt through the sidecar. No-op outside Tauri (browser preview). */
export async function startPrompt(prompt: string, model?: string): Promise<void> {
  if (!isTauri()) {
    console.warn('startPrompt: not running in Tauri — ignored');
    return;
  }
  await invoke('start_prompt', { prompt, model: model ?? null });
}

/** Subscribe to the core's `nc:event` stream. Returns an unlisten function. */
export async function onNcEvent(
  handler: (event: NcEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<NcEvent>('nc:event', (event) => handler(event.payload));
}
