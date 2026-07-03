/** Lazy Shiki highlighter singleton and the hook that drives CodeBlock. */
import { useEffect, useState } from 'react';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/bash.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import githubDark from 'shiki/themes/github-dark-default.mjs';

/** The single dark theme, matching the near-black UI surface. */
const THEME = 'github-dark-default';

/**
 * The 7 grammars loaded into the singleton highlighter (canonical Shiki ids).
 * Imported from Shiki's fine-grained `shiki/core` entry — rather than the bundled
 * `shiki` entry, which lazy-loads EVERY grammar (wolfram, emacs-lisp, …) plus the
 * 600KB+ oniguruma WASM — so only these languages ship in the production bundle.
 */
const LANGS = [bash, javascript, json, jsx, markdown, tsx, typescript];

/** Map an input language token (or file extension) to a loaded grammar id, or
 *  `text` for anything unknown — Shiki always has the built-in plain-text lang. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
};

/** Resolve a language token or file extension to a loaded grammar id, falling
 *  back to `text` for anything unknown or omitted. */
export function resolveLang(language: string | undefined): string {
  if (language === undefined) return 'text';
  const key = language.toLowerCase().replace(/^\./, '').trim();
  return LANG_ALIASES[key] ?? 'text';
}

// Lazy singleton: Shiki is async, so the highlighter (theme + grammars) is created
// once on first use and shared across every CodeBlock. The JavaScript regex engine
// is used over the default WASM engine so no oniguruma binary is bundled.
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark],
      langs: LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/**
 * Above this many characters we skip Shiki entirely and render the raw `<pre>`.
 * `codeToHtml` is fully synchronous CPU work (the JS regex engine, not WASM) with
 * no internal bound, so a 100KB+ diff/source file blocks the main thread for
 * hundreds of ms — dropping frames on the very panel that fed it. Plain text is a
 * correct, instant fallback for payloads that large.
 */
export const MAX_HIGHLIGHT_LENGTH = 50_000;

/** Whether `code` is small enough to highlight synchronously without stalling the
 *  main thread. Exported for the colocated test — pure, no React. */
export function isHighlightable(code: string): boolean {
  return code.length <= MAX_HIGHLIGHT_LENGTH;
}

/**
 * Highlight `code` to a Shiki HTML string, or `null` until the lazy highlighter
 * resolves (and on any failure, or when the body exceeds {@link MAX_HIGHLIGHT_LENGTH})
 * — the caller renders a raw `<pre>` fallback for `null` so there's never a blank
 * flash. Re-runs only when `code`/`language` change; `code` is a primitive string,
 * so an unchanged value never re-highlights even if the parent re-renders.
 */
export function useHighlightedHtml(code: string, language: string | undefined): string | null {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    // Oversized payloads stay as plain <pre>: reset any prior highlight and bail
    // before scheduling the synchronous highlight pass.
    if (!isHighlightable(code)) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    const lang = resolveLang(language);
    getHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        setHtml(highlighter.codeToHtml(code, { lang, theme: THEME }));
      })
      .catch(() => {
        // Highlighter failed to load → keep the raw <pre> fallback.
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return html;
}
