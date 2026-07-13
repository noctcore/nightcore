/**
 * Failure taxonomy for Claude Agent SDK session outcomes. Maps the SDK's
 * assistant-level error strings and a session's `session-failed` `reason` onto
 * the coarse, structured {@link ErrorCategory} the auto-loop + circuit breaker
 * branch on, and onto the {@link ErrorDetail} carried alongside the event so
 * Rust consumers branch on `category`/`retriable` instead of scraping strings.
 * Pure (no SDK import), so each mapping is unit-testable in isolation.
 */
import type {
  ErrorCategory,
  ErrorDetail,
  NightcoreEvent,
} from '@nightcore/contracts';

/** Map an `SDKAssistantMessageError` onto a stable Nightcore failure reason. */
export function mapAssistantError(
  error: string | undefined,
): NightcoreEventOfReason {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'authentication';
    case 'rate_limit':
    case 'overloaded':
      return 'rate-limit';
    case 'max_output_tokens':
      return 'max-turns';
    default:
      return 'unknown';
  }
}

export type NightcoreEventOfReason = Extract<
  NightcoreEvent,
  { type: 'session-failed' }
>['reason'];

/** Map a session failure `reason` (+ its message) onto the coarse, structured
 *  {@link ErrorCategory} the auto-loop + circuit breaker branch on. The reason
 *  drives the bucket; the message is sniffed only to promote a generic
 *  runner-crash/unknown into a `disk-full` when the OS reported ENOSPC (a
 *  fatal-setup cause the breaker must stop on, not retry). */
export function categoryForReason(
  reason: NightcoreEventOfReason,
  message: string,
): ErrorCategory {
  switch (reason) {
    case 'authentication':
      return 'auth';
    case 'rate-limit':
      return 'rate-limit';
    case 'aborted':
      return 'aborted';
    // `max-turns`/`max-budget` hit an autonomy ceiling; `structured-output-failed`
    // means the SDK exhausted its INTERNAL structured-output retries (a decompose
    // run whose output never conformed to the requested schema). All three are
    // terminal + needs-attention — the ceiling/contract was hit and a blind full
    // re-run is unlikely to help — so they bucket as `resource-exhausted`
    // (non-retriable; does not fatal-stop the breaker).
    case 'max-turns':
    case 'max-budget':
    case 'structured-output-failed':
      return 'resource-exhausted';
    case 'runner-crash':
    case 'unknown':
      return looksLikeDiskFull(message) ? 'disk-full' : reason === 'runner-crash'
        ? 'runner-crash'
        : 'unknown';
    default: {
      // Exhaustiveness guard: a new reason must decide its category here.
      const _never: never = reason;
      return _never;
    }
  }
}

/** True when a failure message names an out-of-disk condition (ENOSPC / "no
 *  space left on device"), so a generic crash is promoted to `disk-full`. */
function looksLikeDiskFull(message: string): boolean {
  return /ENOSPC|no space left on device/i.test(message);
}

/** Categories a retry of the SAME operation could plausibly clear. Everything
 *  else (auth, resource ceiling, not-found, disk-full, aborted, unknown) is a
 *  terminal/setup cause the auto-loop must not blindly re-run. */
const RETRIABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'rate-limit',
  'runner-crash',
]);

/** Build the structured {@link ErrorDetail} carried alongside a `session-failed`
 *  event's `reason`/`message`, so Rust consumers branch on `category`/`retriable`
 *  instead of scraping the string. */
export function detailForReason(
  reason: NightcoreEventOfReason,
  message: string,
): ErrorDetail {
  const category = categoryForReason(reason, message);
  return { category, message, retriable: RETRIABLE_CATEGORIES.has(category) };
}
