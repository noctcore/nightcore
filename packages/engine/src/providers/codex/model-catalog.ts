import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { EffortLevel, ModelDescriptor } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import { whichSync } from '@nightcore/shared';

import { type BackoffOptions, withTimeoutAndRetry } from '../../util/retry.js';
import { CODEX_PROVIDER_ID } from './capabilities.js';
import { buildCodexEnv } from './options.js';
import {
  checkCodexBinaryOverride,
  resolveCodexBinaryOverride,
} from './resolve-codex-binary.js';

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Retry the read-only `model/list` probe so a TRANSIENT `codex app-server` blip
 * recovers the real catalog instead of masking as the static fallback (issue #252).
 * Each attempt is already bounded by {@link REQUEST_TIMEOUT_MS} (which kills the
 * child), so a fast transient failure only adds a backoff before retrying; a true
 * hang stays ~one timeout per attempt. The turn-driving `codex exec` run loop is
 * OUT of scope and is never wrapped here.
 */
const MODEL_LIST_RETRIES = 2;
const MODEL_LIST_BACKOFF: BackoffOptions = {
  baseMs: 300,
  factor: 2,
  maxMs: 2_000,
  jitter: true,
};

type AppServerResponse =
  | { id: string; result: unknown }
  | { id: string; error: { message?: string; code?: number } };

interface CodexReasoningEffortOption {
  reasoningEffort?: unknown;
}

interface CodexModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  description?: unknown;
  hidden?: unknown;
  supportedReasoningEfforts?: unknown;
}

interface CodexModelListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

interface CodexExecutable {
  command: string;
  argsPrefix: string[];
}

export const CODEX_MODELS_FALLBACK: ModelDescriptor[] = [
  {
    providerId: CODEX_PROVIDER_ID,
    value: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    description: 'Codex-optimized coding model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
];

const VALID_EFFORTS = new Set<EffortLevel>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** The status of the codex CLI prerequisite check (see {@link probeCodexCli}). */
export interface CodexCliStatus {
  readonly ok: boolean;
  /** A human-actionable reason, present only when `ok` is `false`. */
  readonly message?: string;
}

/** The actionable "codex isn't usable" message surfaced at provider selection. It
 *  covers both not-installed and not-signed-in, since the binary check can't tell an
 *  installed-but-signed-out CLI from a working one without a heavier probe. */
export const CODEX_UNAVAILABLE_HINT =
  'Codex CLI not found. Install Codex (`npm i -g @openai/codex`) and sign in with ' +
  '`codex login`, or set NIGHTCORE_CODEX_PATH to the codex binary.';

/**
 * Validate the codex CLI prerequisite AT PROVIDER SELECTION (issue #144 / D10),
 * mirroring the claude-not-found fail-fast: the user should learn Codex is missing
 * from the read-only inspector, not from a confusing mid-run crash. Resolves the SAME
 * executable a live session/model-catalog would use — an explicit
 * `NIGHTCORE_CODEX_PATH`/`NIGHTCORE_AGENT_PATH` override (existence-validated), the
 * SDK's bundled `@openai/codex` (dev), or `codex` on PATH — and reports whether one
 * is present. Pure fs/PATH lookups (no spawn), so it never blocks the engine. Never
 * throws.
 */
export function probeCodexCli(): CodexCliStatus {
  const override = resolveCodexBinaryOverride();
  const overrideWarning = checkCodexBinaryOverride(override);
  if (overrideWarning !== undefined) {
    // An explicit override that doesn't exist is a configuration error — surface its
    // specific message rather than the generic hint.
    return { ok: false, message: overrideWarning };
  }
  if (override !== undefined) return { ok: true };
  if (resolveBundledCodexEntrypoint() !== undefined) return { ok: true };
  if (whichSync('codex')) return { ok: true };
  return { ok: false, message: CODEX_UNAVAILABLE_HINT };
}

export async function listCodexModels(
  logger?: Logger,
): Promise<ModelDescriptor[]> {
  const codexPathOverride = resolveCodexBinaryOverride();
  const overrideWarning = checkCodexBinaryOverride(codexPathOverride);
  if (overrideWarning !== undefined) {
    logger?.warn('codex model catalog binary override invalid', {
      message: overrideWarning,
    });
    return CODEX_MODELS_FALLBACK;
  }

  const executable = resolveCodexExecutable(codexPathOverride);
  try {
    const models = await withTimeoutAndRetry(() => fetchAppServerModels(executable), {
      retries: MODEL_LIST_RETRIES,
      backoff: MODEL_LIST_BACKOFF,
      onRetry: ({ attempt, error }) =>
        logger?.debug('codex model/list retrying transient blip', {
          attempt,
          message: error instanceof Error ? error.message : String(error),
        }),
    });
    return models.length > 0 ? models : CODEX_MODELS_FALLBACK;
  } catch (error) {
    logger?.warn('codex app-server model/list failed; using fallback catalog', {
      message: error instanceof Error ? error.message : String(error),
    });
    return CODEX_MODELS_FALLBACK;
  }
}

function resolveCodexExecutable(override: string | undefined): CodexExecutable {
  if (override !== undefined) return { command: override, argsPrefix: [] };

  const bundled = resolveBundledCodexEntrypoint();
  if (bundled !== undefined) {
    return { command: process.execPath, argsPrefix: [bundled] };
  }

  return { command: 'codex', argsPrefix: [] };
}

function resolveBundledCodexEntrypoint(): string | undefined {
  try {
    const sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
    const sdkPackageDir = dirname(dirname(realpathSync(sdkEntry)));
    const candidate = join(sdkPackageDir, '..', 'codex', 'bin', 'codex.js');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function fetchAppServerModels(executable: CodexExecutable): Promise<ModelDescriptor[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable.command,
      [...executable.argsPrefix, 'app-server', '--stdio'],
      {
        env: buildCodexEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(`codex app-server model/list timed out after ${REQUEST_TIMEOUT_MS}ms`),
      );
    }, REQUEST_TIMEOUT_MS);

    function finish<T>(
      fn: (value: T) => void,
      value: T,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rl.close();
      child.removeAllListeners();
      child.kill();
      fn(value);
    }

    child.once('error', (error) => finish(reject, error));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('exit', (code, signal) => {
      if (settled) return;
      const detail = signal ?? `code ${code ?? 1}`;
      finish(
        reject,
        new Error(
          `codex app-server exited before model/list completed (${detail}): ${Buffer.concat(
            stderr,
          ).toString('utf8')}`,
        ),
      );
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let parsed: AppServerResponse;
      try {
        parsed = JSON.parse(line) as AppServerResponse;
      } catch {
        return;
      }
      if (parsed.id === 'nightcore-init') {
        if ('error' in parsed) {
          finish(reject, new Error(parsed.error.message ?? 'codex initialize failed'));
          return;
        }
        child.stdin?.write(
          `${JSON.stringify({
            method: 'model/list',
            id: 'nightcore-models',
            params: { includeHidden: false, limit: 100 },
          })}\n`,
        );
        return;
      }
      if (parsed.id === 'nightcore-models') {
        if ('error' in parsed) {
          finish(reject, new Error(parsed.error.message ?? 'codex model/list failed'));
          return;
        }
        finish(resolve, parseModelList(parsed.result));
      }
    });

    child.stdin?.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 'nightcore-init',
        params: {
          clientInfo: {
            name: 'nightcore',
            title: 'Nightcore',
            version: '0.0.0',
          },
          capabilities: null,
        },
      })}\n`,
    );
  });
}

export function parseModelList(response: unknown): ModelDescriptor[] {
  if (response === null || typeof response !== 'object') return [];
  const payload = response as CodexModelListResponse;
  if (!Array.isArray(payload.data)) return [];
  return payload.data
    .map(parseModel)
    .filter((model): model is ModelDescriptor => model !== null);
}

function parseModel(model: unknown): ModelDescriptor | null {
  const item = model as CodexModel;
  if (item.hidden === true) return null;
  const value = stringOrUndefined(item.model) ?? stringOrUndefined(item.id);
  if (value === undefined) return null;
  const displayName = stringOrUndefined(item.displayName) ?? value;
  const description = stringOrUndefined(item.description) ?? '';
  const supportedEffortLevels = parseEfforts(item.supportedReasoningEfforts);
  return {
    providerId: CODEX_PROVIDER_ID,
    value,
    displayName,
    description,
    supportsEffort: supportedEffortLevels.length > 0,
    supportedEffortLevels,
  };
}

function parseEfforts(raw: unknown): EffortLevel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<EffortLevel>();
  for (const item of raw as CodexReasoningEffortOption[]) {
    const effort = item.reasoningEffort;
    if (typeof effort === 'string' && VALID_EFFORTS.has(effort as EffortLevel)) {
      seen.add(effort as EffortLevel);
    }
  }
  return [...seen];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
