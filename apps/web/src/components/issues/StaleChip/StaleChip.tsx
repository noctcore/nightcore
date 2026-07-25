/** The shared "Stale" status chip — an issue that changed on GitHub since it was last
 *  validated. Rendered through Badge `tone="warning"` so the list row and the results
 *  panel share ONE size + tone (GOV-13, killing the prior 4xs/3xs drift). The tooltip
 *  copy differs per surface, so it rides `title` on the wrapper the Badge sits inside
 *  (Badge itself takes no title). */
import { AlertIcon, Badge } from '@/components/ui';

import type { StaleChipProps } from './StaleChip.types';

export function StaleChip({ title, className }: StaleChipProps) {
  return (
    <span title={title} className={className}>
      <Badge tone="warning" className="uppercase tracking-wide">
        <AlertIcon size={10} />
        Stale
      </Badge>
    </span>
  );
}
