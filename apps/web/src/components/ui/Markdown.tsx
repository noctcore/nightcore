/** Sanitizing markdown renderer for assistant and plan text. */
import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Props for {@link Markdown}. */
export interface MarkdownProps {
  /** The raw markdown source to render. */
  children: string;
  /** Extra classes merged onto the rendered container. */
  className?: string;
}

/** Parse markdown to HTML (GitHub-flavored, no raw HTML passthrough) and sanitize
 *  it. Synchronous: `marked.parse` returns a string with `async: false`. Exported
 *  for the colocated test — pure, no React. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** Markdown renderer: a sanitizing, lightweight primitive for assistant turns,
 *  the reviewer verdict, and plan text. `marked` parses to HTML, `DOMPurify`
 *  strips anything unsafe (scripts, event handlers, raw HTML injection). Prose
 *  styling is scoped to `.nc-markdown` in styles.css so code blocks, lists,
 *  headings, and inline code match the app surface. */
export function Markdown({ children, className }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(children), [children]);
  return (
    <div
      className={`nc-markdown text-sm leading-relaxed text-foreground/90 ${className ?? ''}`}
      // Sanitized above — DOMPurify removes scripts/handlers/unsafe markup.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
