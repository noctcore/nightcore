/** Memoized HTML derivation for {@link Markdown}. */
import { useMemo } from 'react';

import { MAX_MARKDOWN_LENGTH, renderMarkdown } from './Markdown.render';

/** Returns parsed HTML, or `null` when the body should render as plain text. */
export function useMarkdownHtml(source: string, streaming: boolean): string | null {
  const plain = streaming || source.length > MAX_MARKDOWN_LENGTH;
  return useMemo(() => (plain ? null : renderMarkdown(source)), [source, plain]);
}
