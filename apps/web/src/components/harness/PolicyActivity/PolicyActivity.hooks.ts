/** Row projection + the "now" clock for the Policy activity feed. */
import { useEffect, useMemo, useState } from 'react';

import type { PolicyActivityEntry } from '@/lib/bridge';

import type { PolicyActivityProps } from './PolicyActivity.types';
import { projectRuleCount, relativeAge, ruleLabel } from './PolicyActivity.utils';

/** How often the rendered ages re-tick. One minute is the smallest unit the
 *  formatter prints, so anything finer would repaint without changing a word. */
const AGE_TICK_MS = 60_000;

/** One rendered row. */
export interface ActivityRow {
  entry: PolicyActivityEntry;
  /** The plain-language reason (never the bare id unless it is unrecognized). */
  label: string;
  /** "4m ago", or `null` for a record with no timestamp. */
  age: string | null;
  /** True when the author's own policy produced the decision. */
  fromPolicy: boolean;
}

/** Everything the PolicyActivity shell renders. */
export interface PolicyActivityVM {
  rows: ActivityRow[];
  /** True before the first read returns (skeleton, not "no denials"). */
  pending: boolean;
  /** True once loaded with nothing to show. */
  empty: boolean;
  /** How many of the shown decisions came from this project's own rules. */
  fromPolicyCount: number;
}

/** Project the feed into rows, re-labelling and re-aging on a slow tick so a
 *  long-open Policy tab does not show stale "just now" rows. */
export function usePolicyActivity({ entries }: PolicyActivityProps): PolicyActivityVM {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo<ActivityRow[]>(
    () =>
      (entries ?? []).map((entry) => ({
        entry,
        label: ruleLabel(entry.ruleId),
        age: relativeAge(entry.ts, now),
        fromPolicy: entry.source === 'policy',
      })),
    [entries, now],
  );

  return {
    rows,
    pending: entries === null,
    empty: entries !== null && entries.length === 0,
    fromPolicyCount: projectRuleCount(entries ?? []),
  };
}
