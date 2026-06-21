import type { TokenUsage } from '@nightcore/contracts';

/** Compact a token count: `12345 → "12.3k"`, `980 → "980"`. Used in the header
 *  stats line and the completion notice so both read identically. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** Human-readable wall-clock duration: `820 → "0.8s"`, `3210 → "3.2s"`,
 *  `92000 → "1m32s"`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`;
}

/** `↑12.3k ↓4.5k` — input/output tokens. Cache reads are appended as `(+Nk cache)`
 *  only when present, to keep the common line uncluttered. */
export function formatUsage(usage: TokenUsage): string {
  const base = `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`;
  return usage.cacheReadTokens > 0
    ? `${base} (+${formatTokens(usage.cacheReadTokens)} cache)`
    : base;
}
