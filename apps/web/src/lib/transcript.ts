/**
 * Provider-neutral accessor for the displayable text of one stored transcript
 * message.
 *
 * Nightcore persists each `SessionMessage.message` as the opaque provider-native
 * payload; today that is the Claude/Anthropic shape (`{ role, content }`, where
 * `content` is a string or an array of typed blocks). This module is the SINGLE
 * place that understands that shape, so issue #18's provider seam can add a
 * per-provider decoder here without touching the history view — and stored
 * Claude transcripts keep rendering unchanged.
 *
 * (Lives in `apps/web/lib` rather than `@nightcore/session-fold`: that package
 * owns only the live-stream partial-dedup decision over already-translated
 * `NightcoreEvent`s and is deliberately free of provider-native message shapes —
 * decoding the stored raw payload is a separate, web-view concern.)
 *
 * Joins every text block; returns an empty string when a turn has no text (e.g.
 * a pure tool-use turn), so the caller can fall back to a type label. Pure.
 */
export function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n\n');
}
