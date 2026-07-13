/**
 * The `session-failed` emission surface for a `SessionRunner`: the actionable
 * CLI-missing guidance and the single builder every failure path (terminal crash,
 * idle stall, missing-CLI preflight) routes through so the structured
 * {@link ErrorDetail} is attached exactly once, consistently.
 */
import type { NightcoreEvent } from '@nightcore/contracts';

import { detailForReason } from './sdk-adapter.js';

type SessionFailedEvent = Extract<NightcoreEvent, { type: 'session-failed' }>;
type SessionFailedReason = SessionFailedEvent['reason'];

/**
 * Actionable guidance shown when no `claude` resolves at session start. Nightcore
 * does NOT bundle the Claude CLI — the user installs it themselves. The install
 * command is the canonical method from the Claude Code setup docs (the install
 * script; npm global install is deprecated upstream), picked per platform so a
 * Windows user gets the PowerShell command, not the macOS/Linux one. Static text,
 * no secrets.
 */
const CLAUDE_INSTALL_COMMAND =
  process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';

export const CLAUDE_CLI_MISSING_MESSAGE =
  'Claude CLI not found. Nightcore requires the Claude CLI — install it with ' +
  `\`${CLAUDE_INSTALL_COMMAND}\` ` +
  '(see https://code.claude.com/docs/en/setup), then retry.';

/**
 * Build a `session-failed` event with its structured {@link ErrorDetail} derived
 * from `reason` + `message`. The one place the detail is attached, so every failure
 * path (crash / stall / CLI-missing) is byte-consistent.
 */
export function sessionFailedEvent(
  sessionId: number,
  reason: SessionFailedReason,
  message: string,
): SessionFailedEvent {
  return {
    type: 'session-failed',
    sessionId,
    reason,
    message,
    detail: detailForReason(reason, message),
  };
}
