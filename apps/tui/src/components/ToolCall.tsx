import type { ReactNode } from 'react';
import type { EditPreview } from '../tool-format.js';
import { editPreview, summarizeTool } from '../tool-format.js';

interface ToolCallProps {
  toolName: string;
  input: Record<string, unknown>;
}

/** A removed/added mini-diff for edit-shaped tools, indented under the call. */
function DiffBlock({ preview }: { preview: EditPreview }): ReactNode {
  return (
    <box style={{ flexDirection: 'column', marginLeft: 4 }}>
      {preview.removed.map((line, i) => (
        <text key={`r-${String(i)}`} fg="#c46f6f">
          {`- ${line}`}
        </text>
      ))}
      {preview.added.map((line, i) => (
        <text key={`a-${String(i)}`} fg="#6fae6f">
          {`+ ${line}`}
        </text>
      ))}
      {preview.truncated > 0 && (
        <text fg="#666666">{`  …(+${String(preview.truncated)} more lines)`}</text>
      )}
    </box>
  );
}

/**
 * Render one tool call: a header line (glyph + label + primary target, plus a
 * dimmed detail) and, for edits, a colored diff of the change. Nested under the
 * assistant answer via the `╰` gutter so tool activity reads as a sub-step.
 */
export function ToolCall({ toolName, input }: ToolCallProps): ReactNode {
  const summary = summarizeTool(toolName, input);
  const preview = editPreview(input);

  return (
    <box style={{ flexDirection: 'column' }}>
      <text>
        <span fg="#444444">{'  ╰ '}</span>
        <span fg="#5fafff">{`${summary.glyph} ${summary.label}`}</span>
        {summary.target.length > 0 && (
          <span fg="#9a9a9a">{` ${summary.target}`}</span>
        )}
        {summary.detail !== undefined && (
          <span fg="#666666">{`  (${summary.detail})`}</span>
        )}
      </text>
      {preview !== null && <DiffBlock preview={preview} />}
    </box>
  );
}
