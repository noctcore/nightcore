/** Presentational pieces of the Project trust dashboard, split out so the card
 *  shell stays readable (the PolicyEditor `.parts` precedent). Pure — every value
 *  arrives already computed by Rust or formatted by `./ProjectTrust.utils`. */
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui';
import type { GovernanceEvent, JournalSummary, TrustBadge } from '@/lib/bridge';

import {
  badgeSwatchClass,
  formatJournalTime,
  journalKindLabel,
  journalKindTone,
} from './ProjectTrust.utils';

/** One headline number with its qualifier. The qualifier is not decoration: a
 *  bare "94%" invites the reader to assume a denominator that may not exist. */
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-nc border border-border/60 bg-white/[0.015] px-3 py-2.5">
      <span className="text-3xs uppercase tracking-wide text-muted-foreground/80">{label}</span>
      <span className="font-mono text-sm font-semibold text-foreground">{value}</span>
      <span className="text-3xs leading-snug text-muted-foreground">{detail}</span>
    </div>
  );
}

/** The shields badge exactly as it will render once published — label chip,
 *  message, and the colour the posture resolved to. */
export function BadgePreview({ badge }: { badge: TrustBadge }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="inline-flex overflow-hidden rounded-md font-mono text-3xs"
        aria-label={`Governance badge: ${badge.message}`}
      >
        <span className="bg-white/[0.06] px-2 py-1 text-muted-foreground">{badge.label}</span>
        <span className={`px-2 py-1 text-background ${badgeSwatchClass(badge.color)}`}>
          {badge.message}
        </span>
      </span>
      <span className="text-3xs text-muted-foreground/80">shields endpoint · {badge.color}</span>
    </div>
  );
}

/** The per-kind roll-up of the whole journal. Counts cover every record; the feed
 *  below is only the recent tail. */
export function JournalCounts({ journal }: { journal: JournalSummary }) {
  const counts: [string, number][] = [
    ['Quarantines', journal.quarantines],
    ['Policy saves', journal.policySaves],
    ['Arms', journal.arms],
    ['Disarms', journal.disarms],
    ['Ratchets', journal.ratchets],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      {counts.map(([label, count]) => (
        <span key={label}>
          <span className="font-mono text-foreground">{count}</span> {label.toLowerCase()}
        </span>
      ))}
      {journal.other > 0 && (
        <span title="Records written by a newer Nightcore than this build knows">
          <span className="font-mono text-foreground">{journal.other}</span> unrecognised
        </span>
      )}
    </div>
  );
}

/** One governance decision, newest first. */
export function JournalLine({ event }: { event: GovernanceEvent }) {
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={journalKindTone(event.kind)}>{journalKindLabel(event.kind)}</Badge>
        <span className="text-2xs-plus text-foreground">{event.summary}</span>
        <span className="ml-auto shrink-0 font-mono text-3xs text-muted-foreground/80">
          {formatJournalTime(event.ts)}
        </span>
      </div>
      {event.detail.length > 0 && (
        <p className="break-all font-mono text-3xs leading-snug text-muted-foreground">
          {event.detail.join(' · ')}
        </p>
      )}
    </li>
  );
}
