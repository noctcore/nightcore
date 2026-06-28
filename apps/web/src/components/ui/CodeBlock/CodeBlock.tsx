/** Syntax-highlighted code block with a raw-text fallback. */
import { useHighlightedHtml } from './CodeBlock.hooks';
import type { CodeBlockProps } from './CodeBlock.types';

// `[&_pre]:!bg-transparent` overrides Shiki's inline background so our container
// surface shows through; the margin reset drops the UA `<pre>` margin.
const CONTAINER =
  'rounded-[10px] border border-border bg-white/[0.02] overflow-x-auto text-[12.5px] leading-relaxed font-mono p-3 [&_pre]:!m-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent';

/**
 * Shiki-highlighted code in the app's dark theme. The lazy singleton highlighter
 * is async, so until it resolves (and if it ever fails) we render the raw `<pre>`
 * — identical text, no blank flash. Unknown languages fall back to plain text.
 */
export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const html = useHighlightedHtml(code, language);
  const containerClass = `${CONTAINER} ${className ?? ''}`;

  if (html === null) {
    return (
      <div className={containerClass}>
        <pre className="m-0 bg-transparent">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className={containerClass}
      // Shiki HTML-escapes the code text and emits only styled <span>s — built
      // from our own `code`/`language` props, never user-authored markup.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
