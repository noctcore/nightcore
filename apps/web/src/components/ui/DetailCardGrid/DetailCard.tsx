/** Shared finding/convention card chrome: a clickable {@link Card} with a badge
 *  row, title, optional grounded `file:line`, and a clamped description. The
 *  Insight finding grid and the Harness convention grid both compose this,
 *  passing only their feature-specific badges (severity / category / effort /
 *  kind / status) into the `badges` slot. */
import type { ReactNode } from 'react';

import { Card } from '../Card';

/** Props for {@link DetailCard}. */
export interface DetailCardProps {
  /** The badge row content (severity, category, effort/kind, status badges). */
  badges: ReactNode;
  title: string;
  /** Pre-formatted grounded `file:line` label, or null/undefined to omit the row. */
  location?: string | null;
  description: string;
  /** Dims the title/location/description for non-open (dismissed/converted) items. */
  dimmed?: boolean;
  /** Native tooltip text shown on hover (e.g. "Converted to task"). */
  hoverTitle?: string;
  onClick: () => void;
}

/** The shared card chrome for a single finding/convention. */
export function DetailCard({
  badges,
  title,
  location,
  description,
  dimmed = false,
  hoverTitle,
  onClick,
}: DetailCardProps) {
  return (
    <Card
      onClick={onClick}
      title={hoverTitle}
      className="flex flex-col gap-2 p-3.5 text-left"
    >
      <div className="flex items-center gap-2">{badges}</div>

      <h3
        className={`text-xs-plus3 font-semibold leading-snug ${dimmed ? 'text-muted-foreground' : 'text-foreground'}`}
      >
        {title}
      </h3>

      {location != null && (
        <code
          title={location ?? undefined}
          className={`truncate font-mono text-2xs ${dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}
        >
          {location}
        </code>
      )}

      <p
        className={`line-clamp-2 text-xs-flat leading-relaxed ${dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}
      >
        {description}
      </p>
    </Card>
  );
}
