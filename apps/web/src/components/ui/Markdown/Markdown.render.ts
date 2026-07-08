/** Pure markdown parse + sanitize helpers for {@link Markdown}. */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

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
