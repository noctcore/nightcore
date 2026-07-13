/**
 * Session-scoped input broadcast — the board's "send once, reach every live agent"
 * fan-out for the human→running-agent chat composer. This is the session-id analog
 * of the terminal PTY broadcast (`terminal/terminal-broadcast`): that one fans
 * keystrokes across VISIBLE PTY panes; this one fans ONE composer message across
 * every LIVE agent SESSION, keyed by task id — the identifier the `send_input`
 * bridge resolves to a numeric session id in the Rust core. The terminal PTY
 * broadcast path is deliberately left untouched (real PTYs stay user-only); this is
 * the sanctioned human→running-agent surface.
 *
 * Adapted, not copied: the armed flag lives in the composer's React state (every
 * input path here is React-driven, unlike the terminal's non-React `onData` / keymap
 * emits that need a module-level mirror), so `armedNow` is passed explicitly rather
 * than read from a module global. The pure targeting rule + the fan-out writer keep
 * the same shape as `resolveBroadcastTargets` / `writeToTargets` so both broadcasts
 * read the same way.
 */

/** Resolve the live session ids (task ids) a send from `originId` lands on. Disarmed
 *  (or no live sessions) → the origin alone — exactly today's single-session send.
 *  Armed → every LIVE session, deduped, always including the origin so the user's own
 *  message is never dropped ("keep the self-write"). Pure + unit-tested — the fan-out
 *  targeting decision lives here, not in the composer. */
export function resolveSessionBroadcastTargets(
  originId: string,
  armedNow: boolean,
  liveIds: readonly string[],
): string[] {
  if (!armedNow || liveIds.length === 0) return [originId];
  const targets = new Set<string>(liveIds);
  targets.add(originId);
  return [...targets];
}

/** Send `text` to `originId`'s session, fanning it out to every LIVE session when
 *  broadcast is armed — else to `originId` alone (today's behavior). The single
 *  fan-out point the composer funnels through; `send` is the bridge relay (the
 *  actions-context `onSendInput`, which toasts on failure and no-ops outside Tauri).
 *  Returns the ids sent to (for tests + callers that ignore it). */
export function broadcastInput(
  originId: string,
  text: string,
  armedNow: boolean,
  liveIds: readonly string[],
  send: (taskId: string, text: string) => void,
): string[] {
  const targets = resolveSessionBroadcastTargets(originId, armedNow, liveIds);
  for (const id of targets) send(id, text);
  return targets;
}
