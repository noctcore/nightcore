import * as fs from 'node:fs';
import { whichSync } from '@nightcore/shared';

/**
 * Resolve a path to the `claude` executable to hand the SDK via
 * `Options.pathToClaudeCodeExecutable`.
 *
 * The SDK normally resolves its bundled `claude` binary from `node_modules` at
 * runtime, which works in-repo but breaks a `bun build --compile` distributable
 * (there's no `node_modules` next to the compiled binary). We override the path
 * ONLY when explicitly asked:
 *
 *   1. `NIGHTCORE_CLAUDE_PATH` if set and it exists on disk; else
 *   2. if `NIGHTCORE_USE_SYSTEM_CLAUDE` is truthy, whatever `which claude`
 *      resolves to on PATH; else
 *   3. `undefined` — leaving the SDK's bundled, version-matched binary in place.
 *
 * Crucially, we do NOT auto-probe `which` in the common case: the SDK bundles a
 * `claude` binary pinned to its own protocol version, and silently swapping in a
 * different globally-installed CLI risks a version mismatch. Compiled
 * distributions opt in via one of the two env vars. All probing failures are
 * swallowed (degrade-not-throw).
 */
export function resolveClaudeBinary(): string | undefined {
  const fromEnv = process.env.NIGHTCORE_CLAUDE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  if (isTruthyEnv(process.env.NIGHTCORE_USE_SYSTEM_CLAUDE)) {
    // `whichSync` is cross-platform (`where` on Windows, `which` elsewhere) and
    // returns null on any failure, so a missing tool degrades rather than throws.
    const found = whichSync('claude');
    if (found && fs.existsSync(found)) return found;
  }

  return undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}
