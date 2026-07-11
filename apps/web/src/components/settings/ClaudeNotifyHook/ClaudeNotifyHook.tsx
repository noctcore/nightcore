import { Button, CheckIcon } from '@/components/ui';

import { useClaudeNotifyHook } from './ClaudeNotifyHook.hooks';
import type { ClaudeNotifyHookProps } from './ClaudeNotifyHook.types';

/** A one-click affordance that COPIES a Claude Code `Stop` hook to the clipboard (T11).
 *  The hook makes a `claude` running inside a Nightcore terminal emit an OSC 777 on
 *  completion, which the terminal's OSC parser turns into a desktop notification. The
 *  user pastes it into `~/.claude/settings.json` — Nightcore never writes the user's own
 *  Claude config (the safe path; a direct write is a deliberate follow-up, not v1). */
export function ClaudeNotifyHook({ className }: ClaudeNotifyHookProps) {
  const { copied, copy } = useClaudeNotifyHook();
  return (
    <Button
      variant="secondary"
      onClick={() => void copy()}
      className={className}
      aria-label="Copy the Claude Code notify hook to the clipboard"
    >
      {copied ? (
        <span className="flex items-center gap-1.5">
          <CheckIcon size={14} />
          Copied
        </span>
      ) : (
        'Copy hook'
      )}
    </Button>
  );
}
