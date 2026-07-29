/** Presentational sub-part of the bulk bar: one gated verb button. Lifted out of
 *  `BulkActionBar.tsx` (the sanctioned `.parts.tsx` pattern) because the same
 *  enabled/aria-disabled/reason-tooltip shape repeats for every verb. */
import { Button } from '@/components/ui';

import type { BulkVerbButtonProps } from './BulkActionBar.types';

/** A bulk verb rendered as a button that NEVER vanishes when unavailable: it goes
 *  `aria-disabled` (so it stays focusable and screen-reader-discoverable) and its tooltip
 *  names the reason. Matches the board's existing "explain, don't hide" discipline for the
 *  card's Run gate and the drawer's Create PR button. */
export function BulkVerbButton({
  verb,
  label,
  icon,
  variant = 'primary',
  title,
}: BulkVerbButtonProps) {
  const inert = !verb.enabled;
  return (
    <Button
      variant={variant}
      aria-disabled={inert}
      title={verb.reason ?? title}
      onClick={inert ? undefined : verb.run}
      className={inert ? 'cursor-not-allowed opacity-40' : undefined}
    >
      {icon}
      {label}
    </Button>
  );
}
