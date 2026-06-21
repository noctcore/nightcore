import type { ReactNode } from 'react';
import { getSyntaxStyle } from '../syntax.js';

interface MarkdownProps {
  content: string;
  /** True while this block is still being streamed into; keeps the trailing
   *  markdown token unstable so partial bold/code/lists don't flicker as final.
   *  Flipped to false once the turn ends so the last block parses cleanly. */
  streaming?: boolean;
}

/**
 * Thin wrapper over OpenTUI's native `<markdown>` renderable. It handles
 * headings, bold/italic, inline code, fenced code blocks, lists, blockquotes,
 * and tables — so assistant output reads as formatted prose instead of raw
 * `**markers**`. The shared `SyntaxStyle` is created lazily (post-renderer).
 */
export function Markdown({ content, streaming = false }: MarkdownProps): ReactNode {
  return (
    <markdown
      content={content}
      syntaxStyle={getSyntaxStyle()}
      streaming={streaming}
      style={{ flexGrow: 1 }}
    />
  );
}
