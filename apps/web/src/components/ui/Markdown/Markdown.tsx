/** Sanitizing markdown renderer for assistant and plan text. */
import { useMarkdownHtml } from './Markdown.hooks';
import type { MarkdownProps } from './Markdown.types';

/** Markdown renderer: a sanitizing, lightweight primitive for assistant turns,
 *  the reviewer verdict, and plan text. `marked` parses to HTML, `DOMPurify`
 *  strips anything unsafe (scripts, event handlers, raw HTML injection). Prose
 *  styling is scoped to `.nc-markdown` in styles.css so code blocks, lists,
 *  headings, and inline code match the app surface.
 *
 *  While a turn streams (`streaming`) or for a very large body, the parse is
 *  skipped and the text renders raw — React escapes the text node, so this path
 *  is safe without `dangerouslySetInnerHTML`. */
export function Markdown({ children, className, streaming = false }: MarkdownProps) {
  const html = useMarkdownHtml(children, streaming);

  if (html === null) {
    return (
      <div
        className={`nc-markdown whitespace-pre-wrap text-sm leading-relaxed text-foreground/90 ${className ?? ''}`}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={`nc-markdown text-sm leading-relaxed text-foreground/90 ${className ?? ''}`}
      // Sanitized above — DOMPurify removes scripts/handlers/unsafe markup.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
