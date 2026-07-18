/** A shared list of grounded evidence anchors for the detail sheets — a
 *  repo-relative `file:line · symbol` location, optionally prefixed with a short
 *  human detail. Used by the Harness convention sheet (location-only) and the
 *  Scorecard reading sheet (detail + location), so both render at one shared size
 *  and gap instead of two near-identical clones. */
import { formatLocation, type LocationLike } from '@/lib/formatters';

/** One evidence row: an optional human detail and a grounded location. A row with
 *  neither renders as an empty `<li>` (callers pass at least one). */
export interface EvidenceItem {
  /** A short human description of the evidence — Scorecard readings carry one;
   *  convention evidence does not. */
  detail?: string | null;
  /** The grounded `file:line` anchor, or `null` when the evidence is unlocated. */
  location: LocationLike | null;
}

export interface EvidenceListProps {
  items: EvidenceItem[];
}

/** Render each evidence item as a `detail file:line · symbol` row at one shared
 *  size (`text-2xs-plus`) and gap. Pure presentational. */
export function EvidenceList({ items }: EvidenceListProps) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, i) => {
        const detail =
          item.detail != null && item.detail.length > 0 ? item.detail : null;
        const location = formatLocation(item.location, { withSymbol: true });
        return (
          <li
            key={`${detail ?? ''}·${location ?? ''}·${i}`}
            className="text-2xs-plus leading-relaxed text-muted-foreground"
          >
            {detail}
            {location !== null && (
              <code
                className={`break-all font-mono text-2xs-plus text-muted-foreground ${
                  detail !== null ? 'ml-1.5' : ''
                }`}
              >
                {location}
              </code>
            )}
          </li>
        );
      })}
    </ul>
  );
}
