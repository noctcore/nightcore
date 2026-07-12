/**
 * Secret redaction for anything the agent's raw inputs can leak into a persisted,
 * exportable artifact — today the session flight-recorder ledger digest (a Bash
 * command line or a target path), tomorrow any report/export writer that echoes a
 * raw tool input. A digest like `curl -H "Authorization: Bearer sk-live-…"` would
 * otherwise land verbatim in `<project>/.nightcore/ledger/<task>.ndjson` and ride
 * along into any Trust-Report / bundle export.
 *
 * Posture (a redactor must never become a gate, mirroring the ledger's fail-open
 * stance): redaction is a pure, total string→string transform — it never throws,
 * never blocks a tool call, and only ever SHRINKS information. If a pattern misses,
 * the worst case is the pre-redaction status quo; it can never over-block work.
 *
 * Scope + honest residual (kept in lockstep with `docs/security/threat-model.md`):
 * this catches the well-known shapes (Bearer headers, common vendor key prefixes,
 * PEM private-key blocks, and `NAME=value` assignments whose NAME is on the
 * {@link SENSITIVE_EXPORT_EXCLUDE} denylist) plus a conservative high-entropy
 * fallback. It is a defence-in-depth net, NOT a guarantee: a novel token shape with
 * no known prefix and modest entropy can still slip through. The structural
 * protection remains that `.nightcore/` is gitignored and owner-only; this reduces
 * the blast radius of an *export* of that directory.
 */

/** The replacement sentinel a redacted span collapses to. */
export const REDACTED = '‹redacted›';

/**
 * Denylist of *names* that carry a secret VALUE in a `NAME=value` / `NAME: value`
 * assignment — the shared list every export/report writer consults (via
 * {@link isSensitiveExportName} / {@link redactSecrets}) so a sensitive assignment
 * is masked no matter which writer emits it. Matched case-insensitively against the
 * assignment's left-hand side (env-var name, CLI flag, JSON/YAML key). Deliberately
 * broad on the "secret noun" side (token/secret/password/key/credential/…) because a
 * false-positive only masks a value, never blocks work.
 */
export const SENSITIVE_EXPORT_EXCLUDE: readonly RegExp[] = [
  /(?:api[_-]?)?token/i,
  /secret/i,
  /password|passwd|pwd/i,
  /(?:access|private|secret|api)[_-]?key/i,
  /credential/i,
  /auth(?:orization)?/i,
  /session[_-]?id/i,
  /cookie/i,
  /(?:aws|gcp|azure|npm|gh|github|gitlab|openai|anthropic|slack)[_-].*(?:key|token|secret)/i,
];

/**
 * Whether `name` (the left-hand side of an assignment, or a config key) names a
 * value that should be excluded from any export/report — the single predicate the
 * ledger writer and any future report writer share, so the denylist lives in ONE
 * place. Empty/whitespace names are never sensitive.
 */
export function isSensitiveExportName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  return SENSITIVE_EXPORT_EXCLUDE.some((re) => re.test(trimmed));
}

/** A PEM private-key block: masked whole (header→footer), including any base64 body. */
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** An `Authorization: Bearer <token>` (or a bare `Bearer <token>`) — mask the token,
 *  keep the scheme so the digest still reads as an auth header. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/**
 * Well-known vendor token prefixes. Each is anchored on a non-token boundary so it
 * doesn't nibble the middle of an unrelated word. The value run is intentionally
 * greedy over the token alphabet — these prefixes are never the start of ordinary
 * prose.
 */
const KNOWN_TOKEN = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{8,}', // OpenAI / Anthropic style
    'gh[posru]_[A-Za-z0-9]{16,}', // GitHub PAT/OAuth/refresh
    'github_pat_[A-Za-z0-9_]{20,}',
    'glpat-[A-Za-z0-9_-]{10,}', // GitLab PAT
    'xox[baprs]-[A-Za-z0-9-]{10,}', // Slack
    'AKIA[0-9A-Z]{16}', // AWS access key id
    'ASIA[0-9A-Z]{16}', // AWS temp access key id
    'AIza[0-9A-Za-z_-]{20,}', // Google API key
    'npm_[A-Za-z0-9]{20,}', // npm token
    'dop_v1_[a-f0-9]{40,}', // DigitalOcean
  ].join('|'),
  'g',
);

/**
 * A `NAME=value` / `NAME: value` assignment whose NAME is sensitive. Captures the
 * name + separator so only the VALUE is masked (`AWS_SECRET_ACCESS_KEY=abc` →
 * `AWS_SECRET_ACCESS_KEY=‹redacted›`). The value run stops at whitespace or a shell
 * separator so a longer command line keeps its structure. A quoted value's opening
 * quote is preserved.
 */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*"?)([^\s"'`;&|]+)/g;

/**
 * A conservative high-entropy fallback: a standalone run of ≥32 token-alphabet
 * chars that carries BOTH letters and digits (so it isn't a plain word, a hex path
 * segment, or a natural-language sentence). Anchored on token boundaries so it never
 * splits a real word. This is the net for a novel token shape with no known prefix;
 * kept conservative to avoid masking commit SHAs (40 hex, digits-or-letters but the
 * mixed-class guard below still requires at least one letter AND one digit — a pure
 * hex sha with no digit, or all-digits, is left alone) and file paths (broken by
 * `/`).
 */
const HIGH_ENTROPY = /(?<![A-Za-z0-9_/+=-])[A-Za-z0-9_+/=-]{32,}(?![A-Za-z0-9_/+=-])/g;

/** Whether a candidate high-entropy run looks secret enough to mask: it must mix at
 *  least one letter and one digit (rejects all-hex shas and all-digit ids alike) and
 *  not read as a filesystem path fragment (no `/`, already excluded by the class). */
function looksSecret(run: string): boolean {
  return /[A-Za-z]/.test(run) && /[0-9]/.test(run);
}

/**
 * Redact secrets from a raw string (a ledger digest, a report line — any text a raw
 * agent input can flow into). Total and pure: never throws, only ever removes
 * information. Order matters — structural patterns (PEM, Bearer, known prefixes,
 * sensitive assignments) run before the entropy fallback so the fallback only sees
 * what the precise rules missed.
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, REDACTED);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(KNOWN_TOKEN, REDACTED);
  // `whole` is the full `name<sep>value` match; the sensitive branch rebuilds it
  // WITHOUT the value (masked), the else-branch returns it verbatim — so the value
  // capture group is never needed as a param.
  out = out.replace(ASSIGNMENT, (whole, name: string, sep: string) =>
    isSensitiveExportName(name) ? `${name}${sep}${REDACTED}` : whole,
  );
  out = out.replace(HIGH_ENTROPY, (run) => (looksSecret(run) ? REDACTED : run));
  return out;
}
