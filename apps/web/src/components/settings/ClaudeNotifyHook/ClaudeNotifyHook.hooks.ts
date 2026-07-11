import { useCallback, useState } from 'react';

import { useToast } from '@/components/ui';

/** The path the snippet is meant for — shown in the copy instructions. */
export const CLAUDE_SETTINGS_PATH = '~/.claude/settings.json';

/** The shell command the hook runs: emit an OSC 777 desktop-notification escape to the
 *  CONTROLLING terminal (the Nightcore PTY the `claude` is running in), which the
 *  terminal's OSC parser turns into a desktop notification (T11 feature #1). Redirected
 *  to `/dev/tty` so it reaches the PTY even when Claude Code captures the hook's stdout;
 *  `2>/dev/null || true` makes it a no-op (never an error) when there is no tty.
 *  `\\033` / `\\007` are the ESC / BEL bytes printf expands. */
const HOOK_COMMAND =
  "printf '\\033]777;notify;Claude Code;Task finished\\007' > /dev/tty 2>/dev/null || true";

/** Build the Claude Code `settings.json` hooks block (pretty-printed JSON) that fires
 *  {@link HOOK_COMMAND} whenever the agent finishes responding (`Stop`). Pure + exported
 *  so the exact copied text is unit-testable. The user MERGES this into their existing
 *  `hooks` object — Nightcore never writes to `~/.claude` itself (the safe path). */
export function claudeNotifyHookSnippet(): string {
  return JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      },
    },
    null,
    2,
  );
}

/** Copy the notify-hook snippet to the clipboard with paste instructions. Returns a
 *  transient `copied` flag (for the button's confirm state) and the `copy` action.
 *  Best-effort: a clipboard failure surfaces a toast rather than throwing. */
export function useClaudeNotifyHook(): { copied: boolean; copy: () => Promise<void> } {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(claudeNotifyHookSnippet());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
      toast.push({
        tone: 'success',
        title: 'Hook copied',
        description: `Merge it into the "hooks" block of ${CLAUDE_SETTINGS_PATH}, then restart Claude Code. A run in a Nightcore terminal will ping you when it finishes.`,
      });
    } catch (err) {
      toast.error('Could not copy the hook', err);
    }
  }, [toast]);
  return { copied, copy };
}
