/** Shared formatting helpers for grounded `file:line` locations rendered across
 *  the Insight, Harness, and Scorecard surfaces. Kept feature-agnostic so the
 *  finding, convention-evidence, and reading views all project their grounded
 *  anchors identically (previously each feature carried its own copy). */

/** The minimal grounded-location shape every surface normalizes into: a
 *  repo-relative file with an optional 1-based line range and an optional symbol. */
export interface LocationLike {
  file: string;
  startLine: number | null;
  endLine: number | null;
  symbol?: string | null;
}

/**
 * Render a grounded location as `file:line`, `file:start-end`, or just `file`
 * when no line is known. Returns `null` for a missing location so callers can
 * omit the row entirely. With `withSymbol`, a present symbol is appended as
 * ` · symbol` — the detail panels show it; the dense card/grid labels do not.
 */
export function formatLocation(
  loc: LocationLike | null,
  opts?: { withSymbol?: boolean },
): string | null {
  if (loc === null) return null;
  if (loc.startLine !== null) {
    const range =
      loc.endLine !== null && loc.endLine !== loc.startLine
        ? `${loc.startLine}-${loc.endLine}`
        : String(loc.startLine);
    const symbol =
      (opts?.withSymbol ?? false) && loc.symbol != null ? ` · ${loc.symbol}` : '';
    return `${loc.file}:${range}${symbol}`;
  }
  return loc.file;
}

/** Format a USD amount as a two-decimal dollar string (e.g. `$0.42`). Shared by
 *  the board cost badges and the RUNNING-screen progress readout. */
export function formatCostUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a timestamp as a compact "time ago" label (`just now`, `5m`, `3h`, `2d`,
 * `4w`, `6mo`, `2y`), for issue/comment age chips. Accepts an ISO-8601 string
 * (GitHub's wire format) or epoch ms; an unparseable value returns `''` so the
 * caller can omit the chip rather than render `NaN`. `now` is injectable for
 * deterministic tests.
 */
export function formatRelativeTime(
  value: string | number,
  now: number = Date.now(),
): string {
  const then = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * Format the time UNTIL a future ISO-8601 string (or epoch ms) as a compact
 * countdown (`2d 3h`, `2h 15m`, `15m`, `<1m`, or `now` once elapsed) — the usage
 * meter's "resets in …" labels. Only the two most-significant units are shown so
 * the label stays glanceable. An unparseable value returns `''` so the caller can
 * omit the label rather than render `NaN`. `now` is injectable for deterministic
 * tests.
 */
export function formatCountdown(value: string | number, now: number = Date.now()): string {
  const target = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(target)) return '';
  const seconds = Math.floor((target - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return '<1m';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * Format a millisecond elapsed span as `m:ss`, clamping negatives to zero.
 * Seconds are always zero-padded to two digits; minutes are padded only when
 * `padMinutes` is set — the board's live card timer shows `01:05`, while the
 * progress readout shows `1:05`.
 */
export function formatElapsed(ms: number, opts?: { padMinutes?: boolean }): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const mm = (opts?.padMinutes ?? false) ? String(minutes).padStart(2, '0') : String(minutes);
  return `${mm}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Format a token count compactly (`842` → `842`, `1_240` → `1.2k`, `34_000` →
 * `34k`, `2_100_000` → `2.1M`) for the run-usage readouts on the scan RESULTS
 * screens, run-history menus, and the review evidence bundle. Negatives clamp to
 * zero. Mirrors the RUNNING-screen `RunProgress` readout so the number a scan
 * shows while running is the same one it shows after it finishes.
 */
export function formatTokensCompact(n: number): string {
  const t = Math.max(0, Math.round(n));
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 10_000) return `${Math.round(t / 1000)}k`;
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  return String(t);
}

/**
 * Format a millisecond duration as a compact human span (`0s`, `12s`, `1m 5s`,
 * `2h 3m`) for the persisted run-duration readouts (scan RESULTS / history rows /
 * run-history menus). Only the two most-significant units are shown so the label
 * stays glanceable. Negatives / NaN clamp to `0s` so a run with no recorded
 * duration renders rather than throwing.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Compact `≈ $cost · duration` receipt for a persisted run, shared by the scan
 * run-history menus and the global History rows (T8). Cost is APPROXIMATE (Trust
 * Report precedent) so it is prefixed `≈`; the duration segment is dropped when a
 * run recorded none. Fail-open: a non-finite cost renders `≈ —` rather than `NaN`.
 */
export function formatRunReceipt(costUsd: number, durationMs: number): string {
  const cost = Number.isFinite(costUsd) ? `≈ ${formatCostUsd(Math.max(0, costUsd))}` : '≈ —';
  return durationMs > 0 ? `${cost} · ${formatDurationMs(durationMs)}` : cost;
}
