import { AlertIcon, CloseIcon, IconButton } from '@/components/ui';

import { useIssueSyncNotice } from './IssueSyncNotice.hooks';
import type { IssueSyncNoticeProps } from './IssueSyncNotice.types';

/** GitHub two-way sync (#97, §3.8) — the writeback-degradation notice. When a
 *  label/comment writeback downgrades because the token lacks issue-write scope,
 *  the Rust ladder stamps a human-readable reason on `task.issueSyncError`; this
 *  banner surfaces it on the task detail. Informational + dismissible — Nightcore
 *  never auto-retries; the user fixes the token scope and re-enables. The message
 *  is Nightcore's own copy (never a token, never raw GitHub text). */
export function IssueSyncNotice({ task }: IssueSyncNoticeProps) {
  const { visible, dismiss } = useIssueSyncNotice(task.issueSyncError);
  if (!visible) return null;
  return (
    <div className="flex items-start gap-2 rounded-[10px] border border-amber-500/40 bg-amber-500/[0.1] px-3 py-2.5">
      <AlertIcon size={15} className="mt-0.5 shrink-0 text-amber-300" />
      <p className="flex-1 text-xs-plus leading-snug text-amber-100/90">{task.issueSyncError}</p>
      <IconButton
        label="Dismiss the issue-sync notice"
        onClick={dismiss}
        className="-mr-1 -mt-0.5 hover:bg-amber-500/[0.15]"
      >
        <CloseIcon size={13} />
      </IconButton>
    </div>
  );
}
