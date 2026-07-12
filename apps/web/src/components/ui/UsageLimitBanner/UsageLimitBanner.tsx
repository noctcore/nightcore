/** A warning banner for a scan RESULTS view whose run matches the rate/usage-limit
 *  signature — $0.00 spent with zero input tokens (see `isUsageLimitSignature`).
 *  A run that "completed" spending nothing almost never means a clean codebase; it
 *  means the provider refused every request under a usage or rate limit, so the
 *  empty result is an artifact of the limit, NOT a real finding of zero issues.
 *  Renders NOTHING when the signature doesn't match, so every call site is a
 *  one-line drop-in on its results screen. Purely presentational. */
import { isUsageLimitSignature } from '@/lib/scan-run';

import { AlertIcon } from '../icons';

interface UsageLimitBannerProps {
  /** The run's lifecycle status — the banner only fires on `completed`. */
  status: string;
  /** Total run cost in USD (transcript-approximated). */
  costUsd: number;
  /** The run's token totals; only `inputTokens` feeds the signature. */
  usage: { inputTokens: number; outputTokens: number };
  /** What the run produced, for the copy ("review" / "analysis" / "grading").
   *  Defaults to the generic "run". */
  runNoun?: string;
  /** Extra classes for the wrapper (call-site spacing). */
  className?: string;
}

export function UsageLimitBanner({
  status,
  costUsd,
  usage,
  runNoun = 'run',
  className,
}: UsageLimitBannerProps) {
  if (!isUsageLimitSignature({ status, costUsd, inputTokens: usage.inputTokens })) {
    return null;
  }
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-[10px] border border-warning/40 bg-warning/[0.08] px-4 py-3 ${className ?? ''}`}
    >
      <AlertIcon size={15} className="mt-0.5 shrink-0 text-warning" />
      <div className="flex flex-col gap-1">
        <p className="text-xs-plus font-semibold text-warning">
          This {runNoun} spent $0.00 and used no tokens — likely a usage limit
        </p>
        <p className="text-xs-flat leading-snug text-muted-foreground">
          A completed {runNoun} that consumed nothing is the signature of a usage or
          rate limit, not a clean result — the provider almost certainly refused
          every request. Empty findings here do NOT mean the code is clean. Check
          your provider usage and re-run.
        </p>
      </div>
    </div>
  );
}
