/** Syntax-highlighted code block with a raw-text fallback. */
import { IconButton } from '../IconButton';
import { CheckIcon, CopyIcon } from '../icons';
import { useCopyFeedback, useHighlightedHtml } from './CodeBlock.hooks';
import type { CodeBlockProps } from './CodeBlock.types';

// `[&_pre]:!bg-transparent` overrides Shiki's inline background so our container
// surface shows through; the margin reset drops the UA `<pre>` margin.
const CONTAINER =
  'rounded-nc border border-border bg-white/[0.02] overflow-x-auto text-xs-plus leading-relaxed font-mono p-3 [&_pre]:!m-0 [&_pre]:!bg-transparent [&_code]:!bg-transparent';

/**
 * Shiki-highlighted code in the app's dark theme. The lazy singleton highlighter
 * is async, so until it resolves (and if it ever fails) we render the raw `<pre>`
 * — identical text, no blank flash. Unknown languages fall back to plain text.
 */
export function CodeBlock({ code, language, className, copyable = true }: CodeBlockProps) {
  const html = useHighlightedHtml(code, language);
  const containerClass = `${CONTAINER} ${className ?? ''}`;

  const body =
    html === null ? (
      <div className={containerClass}>
        <pre className="m-0 bg-transparent">
          <code>{code}</code>
        </pre>
      </div>
    ) : (
      <div
        className={containerClass}
        // Shiki HTML-escapes the code text and emits only styled <span>s — built
        // from our own `code`/`language` props, never user-authored markup.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );

  if (!copyable) return body;
  // The copy control sits OUTSIDE the scrolling code surface (a sibling in the
  // positioned wrapper) so it neither scrolls with long lines nor gets clipped.
  return (
    <div className="group relative">
      {body}
      <CopyButton code={code} />
    </div>
  );
}

/** Hover/focus-revealed copy-to-clipboard control pinned to the block's top-right. */
function CopyButton({ code }: { code: string }) {
  const { copied, copy } = useCopyFeedback(code);
  return (
    <div className="absolute right-2 top-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      <IconButton label={copied ? 'Copied' : 'Copy code'} onClick={copy} className="bg-white/[0.04]">
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </IconButton>
    </div>
  );
}
