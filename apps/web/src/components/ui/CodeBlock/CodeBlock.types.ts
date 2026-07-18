/** Public types for the CodeBlock component. */

/** Props for the CodeBlock component. */
export interface CodeBlockProps {
  /** The source code to render. */
  code: string;
  /**
   * Language token (`ts`, `tsx`, `js`, `jsx`, `json`, `md`, `bash`, and common
   * aliases / file extensions). Anything unknown or omitted falls back to plain
   * text — never throws.
   */
  language?: string;
  /** Extra classes merged onto the container. */
  className?: string;
  /** Show the hover-revealed copy-to-clipboard button (top-right). Default `true`. */
  copyable?: boolean;
}
