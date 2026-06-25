#!/usr/bin/env bun
/**
 * Nightcore headless CLI — `nightcore "do X"`.
 *
 * The end-to-end proof that config + engine + SDK + local-credential auth work:
 * it builds a `SessionManager`, starts one session with the prompt, subscribes
 * to the `NightcoreEvent` stream, and prints assistant output + tool activity to
 * stdout. Plain-stdout only — no TUI dependencies.
 */
import { resolveConfig } from '@nightcore/config';
import { SessionManager } from '@nightcore/engine';
import { createLogger } from '@nightcore/shared';
import type { NightcoreEvent } from '@nightcore/contracts';

interface ParsedArgs {
  prompt: string;
  model?: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { prompt: '', help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '-m' || arg === '--model') {
      args.model = argv[++i];
    } else if (arg !== undefined && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  args.prompt = positional.join(' ');
  return args;
}

const HELP = `Nightcore — powered by Claude

Usage:
  nightcore [options] "<prompt>"

Options:
  -m, --model <id>   Model id (default: from config)
  -h, --help         Show this help

Auth:
  Nightcore inherits your local Claude CLI credentials (~/.claude). Install the
  Claude CLI and run its login first. ANTHROPIC_API_KEY is honored as a fallback.
`;

// When partial streaming is on, the SDK emits each turn's text twice: as
// incremental `partial` deltas AND as a final whole-message block. Track whether
// we've streamed partials so the whole-message duplicate is suppressed.
let streamedPartial = false;

function render(event: NightcoreEvent): void {
  switch (event.type) {
    case 'session-started':
      process.stderr.write(`▶ session ${event.sessionId} (${event.model})\n`);
      break;
    case 'session-ready':
      process.stderr.write(`✓ ready — sdk session ${event.sdkSessionId}\n`);
      break;
    case 'assistant-delta':
      if (event.partial) {
        streamedPartial = true;
        process.stdout.write(event.text);
      } else if (!streamedPartial) {
        process.stdout.write(event.text);
      }
      break;
    case 'tool-use-requested':
      // A tool call ends the current text turn; reset so the next turn's
      // whole-message block prints if that turn streams no partials.
      streamedPartial = false;
      process.stderr.write(`\n🔧 ${event.toolName}(${JSON.stringify(event.input)})\n`);
      break;
    case 'tool-result':
      process.stderr.write(`   ↳ ${event.isError ? 'error' : 'ok'}\n`);
      break;
    case 'permission-required':
      // Headless: auto-deny anything not pre-approved by policy, so the CLI
      // never hangs waiting on a TTY. The TUI surface handles interactive
      // approval. (Run with a permissive policy/mode for autonomous use.)
      process.stderr.write(`\n⚠ permission required for ${event.toolName} — denying (headless)\n`);
      break;
    case 'question-required':
      // Headless: auto-cancel AskUserQuestion (no TTY to answer it) so the run
      // never hangs on a parked dialog. The desktop board handles interactive
      // answers; the SDK applies the dialog default when cancelled.
      process.stderr.write(`\n❓ question asked — skipping (headless)\n`);
      break;
    case 'session-completed':
      process.stdout.write('\n');
      process.stderr.write(
        `\n■ done — ${event.numTurns} turn(s), $${event.costUsd.toFixed(4)}\n`,
      );
      break;
    case 'session-failed':
      process.stdout.write('\n');
      process.stderr.write(`\n✗ failed (${event.reason}): ${event.message}\n`);
      break;
    case 'session-status':
      break;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.prompt) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const config = resolveConfig();
  const logger = createLogger(config.logLevel, 'cli');
  const manager = new SessionManager(config, logger);

  let exitCode = 0;
  await new Promise<void>((resolve) => {
    const unsubscribe = manager.on((event) => {
      render(event);
      if (event.type === 'session-completed') {
        unsubscribe();
        resolve();
      } else if (event.type === 'session-failed') {
        exitCode = 1;
        unsubscribe();
        resolve();
      } else if (event.type === 'permission-required') {
        void manager.dispatch({
          type: 'approve-permission',
          sessionId: event.sessionId,
          requestId: event.requestId,
          decision: { behavior: 'deny', message: 'Headless: not pre-approved.' },
        });
      } else if (event.type === 'question-required') {
        void manager.dispatch({
          type: 'answer-question',
          sessionId: event.sessionId,
          requestId: event.requestId,
          answer: { behavior: 'cancel' },
        });
      }
    });

    void manager.dispatch({
      type: 'start-session',
      prompt: args.prompt,
      model: args.model,
    });
  });

  process.exit(exitCode);
}

void main();
