import type { RunProgressCategory } from '@/components/ui';
import type { FindingCategory } from '@/lib/bridge';

import { CATEGORY_META } from './insight.constants';

/** Extracted to keep InsightView.hooks.ts under the web-file-size ratchet. */
export function buildProgressCategories(
  requested: readonly FindingCategory[],
): RunProgressCategory[] {
  return requested.map((c) => ({
    key: c,
    label: CATEGORY_META[c].label,
    icon: CATEGORY_META[c].icon,
  }));
}
