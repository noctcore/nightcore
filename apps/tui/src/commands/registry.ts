import type { SystemLine } from '../types.js';
import { doctor } from './doctor.js';
import type { Command, CommandContext } from './types.js';

/**
 * The typed slash-command registry. Each command is surface-only: it dispatches
 * `ViewAction`s, reads the engine façade, opens the model picker, or quits — the
 * engine is never touched directly. Order here is the order `/help` lists them.
 */
export const COMMANDS: readonly Command[] = [
  {
    name: 'help',
    summary: 'list commands and keybindings',
    run: (ctx) => {
      const lines: SystemLine[] = [];
      lines.push({ text: 'commands', tone: 'muted' });
      for (const cmd of COMMANDS) {
        lines.push({ text: `  /${cmd.name.padEnd(8)} ${cmd.summary}` });
      }
      // SDK-native commands for the live session (from `session-ready`), shown
      // separately so it's clear they're forwarded to the engine, not local.
      const localNames = new Set(COMMANDS.map((c) => c.name));
      const sdkCommands = ctx.view.slashCommands.filter(
        (name) => !localNames.has(name),
      );
      if (sdkCommands.length > 0) {
        lines.push({ text: '', tone: 'muted' });
        lines.push({ text: 'session commands (forwarded to the engine)', tone: 'muted' });
        for (const name of sdkCommands) {
          lines.push({ text: `  /${name}` });
        }
      }
      if (ctx.view.skills.length > 0) {
        lines.push({ text: '', tone: 'muted' });
        lines.push({ text: 'skills', tone: 'muted' });
        lines.push({ text: `  ${ctx.view.skills.join(', ')}` });
      }
      lines.push({ text: '', tone: 'muted' });
      lines.push({ text: 'keybindings', tone: 'muted' });
      for (const [key, action] of KEYBINDINGS) {
        lines.push({ text: `  ${key.padEnd(12)} ${action}` });
      }
      ctx.dispatch({ type: 'ui-system-message', title: '/help', lines });
    },
  },
  {
    name: 'clear',
    summary: 'clear the transcript (keeps the session)',
    run: (ctx) => {
      ctx.dispatch({ type: 'ui-clear' });
    },
  },
  {
    name: 'model',
    summary: 'pick a model (and its reasoning effort)',
    run: (ctx) => {
      ctx.openModelPicker();
    },
  },
  {
    name: 'doctor',
    summary: 'environment + auth diagnostics',
    run: (ctx) => doctor(ctx),
  },
  {
    name: 'quit',
    summary: 'exit Nightcore',
    run: (ctx) => {
      ctx.quit();
    },
  },
];

/** Keybinding reference, surfaced by `/help`. Kept in lock-step with `App.tsx`. */
const KEYBINDINGS: ReadonlyArray<readonly [string, string]> = [
  ['enter', 'submit the prompt / run the highlighted command'],
  ['shift+enter', 'insert a newline'],
  ['tab', 'complete the highlighted command (autocomplete open)'],
  ['↑ / ↓', 'move the autocomplete highlight'],
  ['shift+tab', 'toggle plan ↔ build'],
  ['esc', 'close autocomplete / interrupt session / deny permission / close picker'],
  ['y / n', 'approve / deny a pending permission'],
  ['ctrl+c', 'quit'],
];

const BY_NAME = new Map<string, Command>(COMMANDS.map((c) => [c.name, c]));

/**
 * Run a parsed slash command. Resolution order:
 *  1. A local registry command → run it (surface-only).
 *  2. Otherwise, if the name is an SDK-native `slashCommand` for the live session
 *     (or there's no SDK list yet to contradict it), forward the literal
 *     `/name args` to the engine as a prompt — the SDK interprets it.
 *  3. Only if it is neither local nor SDK-known do we show "unknown command".
 */
export async function runCommand(
  ctx: CommandContext,
  name: string,
  args: string[],
): Promise<void> {
  const command = BY_NAME.get(name);
  if (command !== undefined) {
    await command.run(ctx, args);
    return;
  }

  // SDK-command bridge: relay session-native commands (and, when we have no SDK
  // list yet, any unknown `/name`) to the engine verbatim so the SDK can handle
  // them. Reconstruct the literal text the operator typed.
  const isSdkCommand = ctx.view.slashCommands.includes(name);
  const literal = args.length > 0 ? `/${name} ${args.join(' ')}` : `/${name}`;
  if (isSdkCommand || ctx.view.slashCommands.length === 0) {
    ctx.forwardPrompt(literal);
    return;
  }

  ctx.dispatch({
    type: 'ui-system-message',
    title: 'unknown command',
    lines: [{ text: `/${name} is not a command — try /help`, tone: 'warn' }],
  });
}
