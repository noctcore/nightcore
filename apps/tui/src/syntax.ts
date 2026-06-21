import { SyntaxStyle } from '@opentui/core';

/**
 * A lazily-created, process-wide `SyntaxStyle` shared by every `<markdown>`,
 * `<code>`, and `<diff>` renderable in the transcript.
 *
 * `SyntaxStyle.create()` reaches into the native render lib, so it must run
 * AFTER `createCliRenderer()` has loaded it — never at module load. Calling it
 * from inside a component's render (which only happens once the renderer is up)
 * is safe. We memoize the handle so all transcript blocks share one style table
 * instead of allocating a native style per assistant message.
 */
let cached: SyntaxStyle | null = null;

export function getSyntaxStyle(): SyntaxStyle {
  cached ??= SyntaxStyle.create();
  return cached;
}
