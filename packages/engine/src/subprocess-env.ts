/**
 * Build the environment handed to the agent subprocess (`Options.env`).
 *
 * WHY A CURATED ALLOWLIST. The SDK's `Options.env` REPLACES the subprocess
 * environment wholesale, so the previous code spread `...process.env` to preserve
 * the essentials. But the desktop app's own environment routinely carries
 * unrelated secrets — `AWS_*`, `GITHUB_TOKEN`, `DATABASE_URL`, cloud credentials —
 * and the autonomous agent runs with whole-machine reach under the default
 * `bypassPermissions`. Spreading the whole parent env hands every one of those
 * secrets to the agent, which can read or exfiltrate them. We instead copy only:
 *
 *   1. system/runtime essentials the subprocess genuinely needs (PATH, HOME,
 *      temp dirs, locale, proxy/TLS config, and the Windows system vars without
 *      which native programs won't run), and
 *   2. the agent's OWN Anthropic/Claude credentials and config (`ANTHROPIC_*`,
 *      `CLAUDE_*`) — those are intended for it.
 *
 * Everything else is dropped. This is intentionally allow-by-name, not
 * deny-by-name: an unknown future secret variable is excluded by default (fails
 * closed) rather than leaking until someone remembers to blocklist it.
 */

/**
 * Exact variable names to pass through (compared case-insensitively, so both
 * `HTTP_PROXY` and `http_proxy` match a single entry). Uppercased here for the
 * membership test.
 */
const ENV_ALLOW_EXACT: ReadonlySet<string> = new Set(
  [
    // POSIX core
    'PATH',
    'HOME',
    'SHELL',
    'USER',
    'LOGNAME',
    'TERM',
    'COLORTERM',
    'TZ',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LANGUAGE',
    // Proxy / TLS (corporate networks break without these)
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    // Windows system vars native programs require
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'PATHEXT',
    'COMSPEC',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'COMPUTERNAME',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'OS',
  ].map((name) => name.toUpperCase()),
);

/**
 * Variable-name PREFIXES to pass through (case-insensitive). Covers the agent's
 * own credentials/config (`ANTHROPIC_*`, `CLAUDE_*`), all locale (`LC_*`) and
 * XDG base-dir (`XDG_*`) vars, and Bun's config (`BUN_*`) since the SDK spawns
 * via `bun`.
 */
const ENV_ALLOW_PREFIXES: readonly string[] = [
  'ANTHROPIC_',
  'CLAUDE_',
  'LC_',
  'XDG_',
  'BUN_',
];

/** True if a variable name is on the allowlist (exact or by prefix). */
export function isAllowedEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (ENV_ALLOW_EXACT.has(upper)) return true;
  return ENV_ALLOW_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Produce the curated subprocess environment: the allowlisted subset of `parent`,
 * with `overrides` applied last (Nightcore-controlled vars like
 * `CLAUDE_CODE_ENABLE_TASKS` always win, even if filtered out of the parent).
 * `undefined` values in `parent` are skipped.
 */
export function buildSubprocessEnv(
  parent: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isAllowedEnvVar(key)) out[key] = value;
  }
  return { ...out, ...overrides };
}
