/**
 * Shared internal helpers for the web↔Rust bridge: the Tauri-webview probe and the
 * fallback-aware `invoke` wrapper. Split out of the old monolith so both the command
 * wrappers (`./commands`) and the event subscribers (`./events`) can depend on them
 * without importing each other.
 */
import { invoke } from '@tauri-apps/api/core';

/** True when running inside the Tauri webview (vs. a plain browser preview). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Invoke a Tauri command, returning `fallback` (resolved) outside the webview so
 *  Storybook/browser preview no-ops with mock data instead of rejecting. Folds the
 *  repeated `if (!isTauri()) return …` guard into one place. */
export function tauriInvoke<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: T,
): Promise<T> {
  if (!isTauri()) return Promise.resolve(fallback);
  return invoke<T>(command, args);
}
