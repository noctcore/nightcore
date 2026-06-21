import type { SessionView } from '../types.js';
import { COMMANDS } from './registry.js';

/** One selectable command in the autocomplete dropdown / `/help` listing. A
 *  `local` entry comes from the surface registry (has a real description); an
 *  `sdk` entry is a session-native command forwarded to the engine. */
export interface PaletteEntry {
  /** Command name WITHOUT the leading slash. */
  name: string;
  description: string;
  source: 'local' | 'sdk';
}

const SDK_DESCRIPTION = '(session command)';

/**
 * Build the full command palette for the current view: local registry commands
 * first (the surface's own), then SDK-native `slashCommands` that aren't shadowed
 * by a local command of the same name. Local commands win on name collision so a
 * `/help` always runs the rich surface version.
 */
export function buildPalette(view: SessionView): PaletteEntry[] {
  const localNames = new Set(COMMANDS.map((c) => c.name));
  const local: PaletteEntry[] = COMMANDS.map((c) => ({
    name: c.name,
    description: c.summary,
    source: 'local',
  }));
  const sdk: PaletteEntry[] = view.slashCommands
    .filter((name) => !localNames.has(name))
    .map((name) => ({ name, description: SDK_DESCRIPTION, source: 'sdk' }));
  return [...local, ...sdk];
}

/**
 * Filter the palette to entries whose name starts with `prefix` (the typed
 * command name, without the leading slash), case-insensitively. An empty prefix
 * returns the whole palette so a bare `/` shows everything.
 */
export function matchPalette(
  view: SessionView,
  prefix: string,
): PaletteEntry[] {
  const lower = prefix.toLowerCase();
  return buildPalette(view).filter((e) => e.name.startsWith(lower));
}
