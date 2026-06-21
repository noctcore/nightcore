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
  ['enter', 'submit the prompt'],
  ['shift+enter', 'insert a newline'],
  ['shift+tab', 'toggle plan ↔ build'],
  ['esc', 'interrupt session / deny permission / close picker'],
  ['y / n', 'approve / deny a pending permission'],
  ['ctrl+c', 'quit'],
];

const BY_NAME = new Map<string, Command>(COMMANDS.map((c) => [c.name, c]));

/**
 * Run a parsed slash command. Unknown names dispatch a notice rather than
 * throwing, mirroring Claude Code's "unknown command" hint.
 */
export async function runCommand(
  ctx: CommandContext,
  name: string,
  args: string[],
): Promise<void> {
  const command = BY_NAME.get(name);
  if (command === undefined) {
    ctx.dispatch({
      type: 'ui-system-message',
      title: 'unknown command',
      lines: [{ text: `/${name} is not a command — try /help`, tone: 'warn' }],
    });
    return;
  }
  await command.run(ctx, args);
}
