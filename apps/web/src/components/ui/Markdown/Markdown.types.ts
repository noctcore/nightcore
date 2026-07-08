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
