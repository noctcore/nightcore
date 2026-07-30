/** Presentation helpers for the Project trust dashboard.
 *
 *  The backend returns raw numbers and raw event kinds — the stable, greppable
 *  facts shared with the journal, the badge and the ledger. Turning them into the
 *  words a human reads is presentation, so it lives here. An UNKNOWN journal kind
 *  renders as itself: a record written by a newer Nightcore must stay visible and
 *  attributable, never swallowed. */
import type { BadgeTone } from '@/components/ui';

/** Journal kind → the past-tense decision a human reads. */
const KIND_LABELS: Record<string, string> = {
  quarantine: 'Quarantined',
  'policy-save': 'Policy saved',
  arm: 'Armed',
  disarm: 'Disarmed',
  ratchet: 'Ratchet',
};

/** Journal kind → badge tone. Loosening a rail (disarm) reads as a warning and
 *  tightening one (arm / ratchet) as success, because that is the direction the
 *  reader cares about when scanning a governance history. */
const KIND_TONES: Record<string, BadgeTone> = {
  quarantine: 'info',
  'policy-save': 'primary',
  arm: 'success',
  disarm: 'warning',
  ratchet: 'success',
};

/** Shields colour name → the swatch class for the badge preview. Only the colours
 *  the Rust posture can emit are mapped; anything else falls back to neutral. */
const BADGE_SWATCH: Record<string, string> = {
  brightgreen: 'bg-success',
  green: 'bg-success/70',
  yellow: 'bg-warning',
  orange: 'bg-warning/70',
  red: 'bg-destructive',
  lightgrey: 'bg-muted-foreground/60',
};

/** The label for a journal kind, falling back to the raw kind. */
export function journalKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The tone for a journal kind; an unknown kind stays neutral. */
export function journalKindTone(kind: string): BadgeTone {
  return KIND_TONES[kind] ?? 'neutral';
}

/** The swatch class for a shields colour name. */
export function badgeSwatchClass(color: string): string {
  return BADGE_SWATCH[color] ?? 'bg-muted-foreground/60';
}

/** A gauntlet pass rate as a whole percent, or an em dash when it has never run.
 *  NEVER renders `0%` for "no data" — that would read as a failing project. */
export function formatPassRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** A USD amount at cent precision (`$41.87`). */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** An ISO-8601 UTC stamp as a compact `YYYY-MM-DD HH:MM` (still UTC).
 *
 *  Absolute, not relative: this is an audit trail, and "3d ago" is the wrong unit
 *  for a governance record a reader may be comparing against a commit or a PR.
 *  Pure string slicing on the shape the Rust writer emits — a value in any other
 *  shape is passed through verbatim rather than mangled. */
export function formatJournalTime(ts: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
  if (match === null) return ts;
  return `${match[1]} ${match[2]}`;
}
