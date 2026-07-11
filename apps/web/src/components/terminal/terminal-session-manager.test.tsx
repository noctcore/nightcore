import { afterEach, expect, test, vi } from 'vitest';

import { writeTerminal } from '@/lib/bridge';

import {
  attachSession,
  clearUnread,
  closeSession,
  ensureRenderer,
  getUnread,
  openSession,
  setActiveTerminal,
  subscribeActivity,
} from './terminal-session-manager';
import { setWebglLoader, type WebglController } from './terminal-webgl';

// Outside Tauri the bridge drives the in-memory echo terminal, so `openSession`
// spawns a real xterm bound to the echo (no PTY, no GPU). The WebGL loader is
// injected so the fallback path is exercised WITHOUT a real WebGL context (headless
// chromium has none) — the seam the production loader hides behind.

afterEach(() => {
  setWebglLoader(null);
  vi.restoreAllMocks();
});

test('a WebGL session loads the renderer once and falls back to DOM on context loss', async () => {
  // A fake loader that captures the context-loss callback and hands back a
  // disposable controller, so the test can trigger the loss deterministically. The
  // callback lives on an object so TS doesn't narrow it back to `null` after the
  // closure assignment.
  const captured: { onLoss: (() => void) | null } = { onLoss: null };
  const dispose = vi.fn();
  const loader = vi.fn(
    (_term: unknown, onContextLoss: () => void): Promise<WebglController | null> => {
      captured.onLoss = onContextLoss;
      return Promise.resolve({ dispose });
    },
  );
  setWebglLoader(loader as never);

  const container = document.createElement('div');
  container.style.width = '400px';
  container.style.height = '240px';
  document.body.appendChild(container);

  // Spawn WITH webgl enabled, attach (opens the xterm), then load the renderer.
  const session = await openSession(
    { cwd: '/tmp/project', confined: false, cols: 80, rows: 24 },
    true,
  );
  const detach = attachSession(session.id, container);

  const onFallback = vi.fn();
  await ensureRenderer(session.id, onFallback);
  expect(loader).toHaveBeenCalledTimes(1);

  // A second ensureRenderer (e.g. a re-attach) must NOT re-load the addon.
  await ensureRenderer(session.id, onFallback);
  expect(loader).toHaveBeenCalledTimes(1);

  // Simulate the WebGL context being lost: the manager disposes the addon (reverting
  // to DOM) and invokes the fallback callback (which the pane turns into a toast).
  expect(captured.onLoss).not.toBeNull();
  captured.onLoss?.();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(onFallback).toHaveBeenCalledTimes(1);

  detach();
  await closeSession(session.id);
  container.remove();
});

test('output for a non-visible session accrues an unread badge, cleared on activation', async () => {
  // Nothing visible → every session's output badges. The echo bridge echoes any
  // written bytes back through the SAME callback that records activity, so a write
  // simulates background shell output arriving on an inactive tab.
  setActiveTerminal(null);
  const notified = vi.fn();
  const unsub = subscribeActivity(notified);

  const session = await openSession(
    { cwd: '/tmp/background', confined: false, cols: 80, rows: 24 },
    false,
  );
  await writeTerminal(session.id, new TextEncoder().encode('ls\r'));
  await vi.waitFor(() => expect(getUnread(session.id)).toBeGreaterThan(0));
  expect(notified).toHaveBeenCalled();

  // Activating the tab clears its badge and stops it accruing more.
  setActiveTerminal(session.id);
  expect(getUnread(session.id)).toBe(0);

  // Output for the now-visible session does not badge.
  await writeTerminal(session.id, new TextEncoder().encode('pwd\r'));
  expect(getUnread(session.id)).toBe(0);

  // A redundant clear is a no-op (no throw, stays 0).
  clearUnread(session.id);
  expect(getUnread(session.id)).toBe(0);

  unsub();
  setActiveTerminal(null);
  await closeSession(session.id);
});

test('a DOM session never invokes the WebGL loader', async () => {
  const loader = vi.fn();
  setWebglLoader(loader as never);

  const container = document.createElement('div');
  document.body.appendChild(container);

  const session = await openSession(
    { cwd: '/tmp/project', confined: false, cols: 80, rows: 24 },
    false,
  );
  const detach = attachSession(session.id, container);
  await ensureRenderer(session.id, vi.fn());
  expect(loader).not.toHaveBeenCalled();

  detach();
  await closeSession(session.id);
  container.remove();
});
