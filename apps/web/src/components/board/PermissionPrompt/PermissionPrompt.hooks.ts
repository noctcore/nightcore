/** Re-exports the shared input-summary helpers from `@/lib/summarize`. Kept here so
 *  the component + barrel imports stay stable. */
import { useCallback, useRef, useState } from 'react';

export { summarizeInput, truncate } from '@/lib/summarize';

/** The allow/deny decision made from a permission prompt. */
type Decision = 'allow' | 'deny';

/** In-flight decision state for {@link PermissionPrompt}. Approving/denying an
 *  agent's tool request is consequential and irreversible, so the first click
 *  latches the decision: both buttons then disable + report `aria-busy` and a
 *  second click is a no-op, closing the double-fire window (mirrors the
 *  QuestionPrompt sibling, whose Send latches on submit). The parked prompt
 *  unmounts once the run resumes, so the latch never needs resetting.
 *
 *  A ref latches synchronously (defense-in-depth against a double-click landing
 *  before the disabled re-render, and StrictMode-safe); the state drives the UI. */
export function usePermissionDecision(
  requestId: string,
  onRespond: (requestId: string, decision: Decision) => void,
): { deciding: Decision | null; respond: (decision: Decision) => void } {
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const decidedRef = useRef(false);

  const respond = useCallback(
    (decision: Decision) => {
      if (decidedRef.current) return; // already answered — ignore the repeat.
      decidedRef.current = true;
      setDeciding(decision);
      onRespond(requestId, decision);
    },
    [requestId, onRespond],
  );

  return { deciding, respond };
}
