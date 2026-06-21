/** A parsed slash command: the bare name (without the leading `/`) plus any
 *  whitespace-separated arguments. */
export interface ParsedSlash {
  name: string;
  args: string[];
}

/**
 * Parse a slash command out of the raw input buffer. Returns `null` when the
 * text is an ordinary prompt (does not start with `/`, or is a lone `/`), so the
 * caller can fall through to starting a session.
 *
 * Slash handling lives entirely in the surface — the engine never sees these.
 */
export function parseSlash(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/).filter((p) => p.length > 0);
  const name = parts[0];
  if (name === undefined) return null;

  return { name: name.toLowerCase(), args: parts.slice(1) };
}
