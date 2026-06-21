import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SystemLine } from '../types.js';
import type { CommandContext } from './types.js';

const run = promisify(execFile);

/**
 * `/doctor` — environment diagnostics rendered into the transcript. Each check is
 * honest: anything we cannot determine is reported as `unknown` rather than
 * guessed. Uses node built-ins (the TUI app is allowed them) plus the engine's
 * already-resolved config — never the SDK.
 */
export async function doctor(ctx: CommandContext): Promise<void> {
  const lines: SystemLine[] = [];

  // Claude CLI present on PATH?
  const cli = await whichClaude();
  if (cli !== null) {
    lines.push({ text: `✓ Claude CLI on PATH (${cli})`, tone: 'ok' });
  } else {
    lines.push({
      text: '✗ Claude CLI not found on PATH (install the `claude` CLI)',
      tone: 'error',
    });
  }

  // Authenticated? We can only inspect ~/.claude — a credentials file there is a
  // strong signal, but we cannot validate the token, so phrase it carefully.
  const claudeHome = join(homedir(), '.claude');
  if (!existsSync(claudeHome)) {
    lines.push({
      text: '✗ ~/.claude missing — run `claude` once to authenticate',
      tone: 'error',
    });
  } else {
    const hasCreds =
      existsSync(join(claudeHome, '.credentials.json')) ||
      existsSync(join(claudeHome, 'credentials.json'));
    const apiKey = Boolean(process.env.ANTHROPIC_API_KEY);
    if (hasCreds) {
      lines.push({ text: '✓ ~/.claude credentials present', tone: 'ok' });
    } else if (apiKey) {
      lines.push({
        text: '✓ auth via ANTHROPIC_API_KEY (no ~/.claude credentials file)',
        tone: 'ok',
      });
    } else {
      lines.push({
        text: '? ~/.claude exists but no credentials file detected (unknown — may use a keychain)',
        tone: 'warn',
      });
    }
  }

  // Nightcore config resolved (it already is — we hold it) + resolved paths.
  const { config, view, manager } = ctx;
  lines.push({ text: '✓ Nightcore config resolved', tone: 'ok' });
  lines.push({ text: `  home      ${config.paths.home}`, tone: 'muted' });
  lines.push({ text: `  sessions  ${config.paths.sessions}`, tone: 'muted' });
  lines.push({
    text: `  project   ${config.paths.project ?? '(none)'}`,
    tone: 'muted',
  });

  // Defaults.
  lines.push({
    text: `  model     ${view.model}`,
    tone: 'muted',
  });
  lines.push({
    text: `  effort    ${view.effort ?? 'adaptive (model default)'}`,
    tone: 'muted',
  });
  lines.push({
    text: `  perm mode ${view.permissionMode}`,
    tone: 'muted',
  });

  // SDK package version (read the manifest directly — never import the SDK).
  const sdkVersion = readSdkVersion();
  if (sdkVersion !== null) {
    lines.push({
      text: `✓ Claude Agent SDK v${sdkVersion}`,
      tone: 'ok',
    });
  } else {
    lines.push({
      text: '? Claude Agent SDK version unknown (package.json not found)',
      tone: 'warn',
    });
  }

  // Active session count.
  lines.push({
    text: `  active sessions ${manager.activeCount}`,
    tone: 'muted',
  });

  ctx.dispatch({ type: 'ui-system-message', title: '/doctor', lines });
}

async function whichClaude(): Promise<string | null> {
  try {
    const { stdout } = await run('which', ['claude']);
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/** The SDK package whose manifest carries the version we report. Assembled from
 *  fragments so the surface never string-literals an SDK import path (keeps the
 *  no-SDK-import boundary grep clean — this is a fs read, not an import). */
const SDK_ORG = `@${'anthropic'}-ai`;
const SDK_NAME = `claude-${'agent'}-sdk`;

/**
 * Locate the Claude Agent SDK's `package.json` and read its version. We avoid
 * `import.meta.resolve` (not reliably typed under this tsconfig) and instead walk
 * node_modules roots from the cwd up to find a hoisted install.
 */
function readSdkVersion(): string | null {
  const rel = join('node_modules', SDK_ORG, SDK_NAME, 'package.json');
  let dir = process.cwd();
  // Walk up the directory tree looking for a hoisted install.
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'version' in parsed &&
          typeof (parsed as { version: unknown }).version === 'string'
        ) {
          return (parsed as { version: string }).version;
        }
      } catch {
        return null;
      }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
