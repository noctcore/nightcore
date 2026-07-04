/** Sanitizing markdown renderer for assistant and plan text. */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

/** Props for {@link Markdown}. */
export interface MarkdownProps {
  /** The raw markdown source to render. */
  children: string;
  /** Extra classes merged onto the rendered container. */
  className?: string;
  /** True while `children` is a still-streaming turn that grows one delta at a
   *  time. Skips the heavy `marked`+`DOMPurify` pass and renders escaped plain
   *  text so each delta is a cheap text update instead of a full re-parse of the
   *  whole accumulated document (which is O(n²) over a turn). The full markdown
   *  pass runs once, on the settled body, when this flips back to false. */
  streaming?: boolean;
}

/** Bodies larger than this render as escaped plain text rather than parsed
 *  markdown: `marked`+`DOMPurify` over a 100KB+ document is a synchronous
 *  main-thread stall, and a body that big is invariably a raw log/diff dump
 *  where the prose styling adds nothing. */
export const MAX_MARKDOWN_LENGTH = 50_000;

// Harden every anchor the sanitizer keeps: an in-markdown link comes from
// untrusted text (agent output, PR bodies, findings, reviewer verdicts) and a
// bare click would navigate the top-level WKWebView away from index.html.
// Forcing `target="_blank"` + `rel="noopener noreferrer"` sends the click to a
// new context and severs `window.opener`, so the app frame is never hijacked.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Parse markdown to HTML (GitHub-flavored, no raw HTML passthrough) and sanitize
 *  it. Synchronous: `marked.parse` returns a string with `async: false`. Exported
 *  for the colocated test — pure, no React. The sanitize pass also runs the
 *  module-level `afterSanitizeAttributes` hook that hardens surviving anchors. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

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
  const plain = streaming || children.length > MAX_MARKDOWN_LENGTH;
  // `useMemo` runs unconditionally (stable hook order); the parse itself is
  // gated so a streaming/oversized body never pays for it.
  const html = useMemo(() => (plain ? null : renderMarkdown(children)), [children, plain]);

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
