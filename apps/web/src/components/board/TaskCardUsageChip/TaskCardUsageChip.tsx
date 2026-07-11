import { AlertIcon } from '@/components/ui';

import { providerDisplay, useUsageHot } from '../usage-hot';

/** An ADVISORY "usage high" chip beside a task card's Run/Retry affordance (spec
 *  2026-07-11): shown when the run provider's usage meter is hot (any window at/above
 *  the throttle threshold). It never disables the button — manual starts stay allowed
 *  (decision 1); it only warns that the run counts against a near-full limit. Reads
 *  the derived hot window from context (like `TaskCardTerminalChip` reads its own
 *  data) and renders nothing when usage is cool / the meter is off. */
export function TaskCardUsageChip() {
  const hot = useUsageHot();
  if (hot === null) return null;
  return (
    <span
      title={`${providerDisplay(hot.provider)} ${hot.windowLabel} at ${Math.round(
        hot.usedPercent,
      )}% — this run counts against your limit.`}
      className="flex items-center gap-1 rounded-lg bg-warning/[0.14] px-2 py-1.5 font-mono text-[10.5px] font-semibold text-warning"
    >
      <AlertIcon size={12} />
      usage high
    </span>
  );
}
