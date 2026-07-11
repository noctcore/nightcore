/** Props for {@link ClaudeNotifyHook} — the one-click "copy the Claude notify hook"
 *  affordance in Settings → Notifications (T11). It COPIES a Claude Code `Stop` hook
 *  to the clipboard for the user to paste into `~/.claude/settings.json`; Nightcore
 *  never writes to the user's Claude config itself (the safe path for v1). */
export interface ClaudeNotifyHookProps {
  /** Optional extra classes for the button (layout passthrough). */
  className?: string;
}
