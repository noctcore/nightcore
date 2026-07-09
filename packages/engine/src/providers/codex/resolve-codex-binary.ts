import { existsSync } from 'node:fs';

/** Environment override used by provider launchers that share one binary knob. */
const AGENT_PATH_ENV = 'NIGHTCORE_AGENT_PATH';
/** Codex-specific binary override. */
const CODEX_PATH_ENV = 'NIGHTCORE_CODEX_PATH';

/** Resolve a user-supplied Codex binary path, if one was configured.
 *
 * The SDK has its own vendored fallback via `@openai/codex`; returning
 * `undefined` deliberately lets that path work. Only explicit Nightcore overrides
 * are validated here so a typo fails before a session starts.
 */
export function resolveCodexBinaryOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env[AGENT_PATH_ENV] ?? env[CODEX_PATH_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    return undefined;
  }
  return configured;
}

/** Validate an explicit override. The SDK fallback is checked by the SDK itself. */
export function checkCodexBinaryOverride(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return existsSync(path) ? undefined : `Codex binary override does not exist: ${path}`;
}
