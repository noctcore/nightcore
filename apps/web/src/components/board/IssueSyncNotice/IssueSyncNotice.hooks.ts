import { useCallback, useState } from 'react';

/** The dismissible-notice view returned by {@link useIssueSyncNotice}. */
export interface IssueSyncNoticeView {
  /** Whether the notice should render: an error is present and not yet dismissed. */
  visible: boolean;
  /** Dismiss the CURRENT error text. A subsequent, DIFFERENT degradation reason
   *  re-shows the notice (dismissal is keyed by the message, not a one-shot flag). */
  dismiss: () => void;
}

/** Drive the one-time, dismissible issue-sync degradation notice (§3.8). The
 *  dismissal is keyed by the error STRING so a genuinely new degradation reason
 *  (e.g. comments-only → silent-off) re-surfaces the banner, while re-emitting the
 *  same reason after a dismiss stays quiet. State lives here (not the component
 *  body) per the no-state-in-body convention. */
export function useIssueSyncNotice(error: string | undefined): IssueSyncNoticeView {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismiss = useCallback(() => setDismissed(error ?? null), [error]);
  const visible = error !== undefined && error.length > 0 && dismissed !== error;
  return { visible, dismiss };
}
