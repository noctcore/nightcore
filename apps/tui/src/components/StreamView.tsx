import type { ReactNode } from 'react';
import type { NoticeTone, SystemLine, TranscriptEntry } from '../types.js';

interface StreamViewProps {
  transcript: TranscriptEntry[];
}

const NOTICE_COLOR: Record<NoticeTone, string> = {
  info: '#7f7f9f',
  success: '#5faf5f',
  error: '#ff5f5f',
};

const SYSTEM_LINE_COLOR: Record<
  NonNullable<SystemLine['tone']>,
  string
> = {
  ok: '#5faf5f',
  warn: '#d7af00',
  error: '#ff5f5f',
  muted: '#777777',
};

/** Kinds that open a new conversational turn; the reducer interleaves them so a
 *  little top margin makes the transcript read as alternating blocks rather than
 *  one wall of text. */
function isTurnStart(kind: TranscriptEntry['kind']): boolean {
  return kind === 'user' || kind === 'system';
}

function Entry({
  entry,
  first,
}: {
  entry: TranscriptEntry;
  first: boolean;
}): ReactNode {
  // Open each new turn with a blank line of separation (except the very first).
  const marginTop = !first && isTurnStart(entry.kind) ? 1 : 0;

  switch (entry.kind) {
    case 'user':
      return (
        <box style={{ flexDirection: 'row', marginTop }}>
          <text fg="#5fafff">▌ </text>
          <box style={{ flexDirection: 'column', flexGrow: 1 }}>
            <text fg="#9cdcfe">
              <strong>you</strong>
            </text>
            <text fg="#cfd8e3">{entry.text}</text>
          </box>
        </box>
      );

    case 'assistant':
      return (
        <box style={{ flexDirection: 'row' }}>
          <text fg="#5f8f5f">▌ </text>
          <text fg="#e4e4e4" style={{ flexGrow: 1 }}>
            {entry.text}
          </text>
        </box>
      );

    case 'tool-call':
      // Nested under the assistant answer: extra indent past the ▌ gutter.
      return (
        <text>
          <span fg="#444444">  ╰ </span>
          <span fg="#5fafff">⚙ {entry.toolName}</span>
          <span fg="#666666"> {entry.input}</span>
        </text>
      );

    case 'tool-result':
      return (
        <text fg={entry.isError ? '#ff5f5f' : '#5faf5f'}>
          {entry.isError ? '    ↳ error: ' : '    ↳ '}
          {entry.content}
        </text>
      );

    case 'notice':
      return <text fg={NOTICE_COLOR[entry.tone]}>• {entry.text}</text>;

    case 'system':
      return (
        <box
          title={entry.title}
          style={{
            border: true,
            borderColor: '#3a3a4a',
            marginTop,
            paddingLeft: 1,
            paddingRight: 1,
            flexDirection: 'column',
          }}
        >
          {entry.lines.map((line, i) => (
            <text
              // System lines are static once rendered; index keys are stable here.
              key={`${entry.id}-${String(i)}`}
              fg={SYSTEM_LINE_COLOR[line.tone ?? 'muted']}
            >
              {line.text.length === 0 ? ' ' : line.text}
            </text>
          ))}
        </box>
      );
  }
}

/** Scrollable transcript. The reducer appends entries; `stickyScroll` keeps the
 *  newest output in view as the assistant streams. User and assistant turns get
 *  distinct accent gutters; tool activity nests under the answer. */
export function StreamView({ transcript }: StreamViewProps): ReactNode {
  return (
    <scrollbox
      focused={false}
      style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
      stickyScroll
      stickyStart="bottom"
    >
      {transcript.length === 0 ? (
        <text fg="#555555">
          Type a prompt and press Enter to start a session. Type /help for
          commands.
        </text>
      ) : (
        transcript.map((entry, i) => (
          <Entry key={entry.id} entry={entry} first={i === 0} />
        ))
      )}
    </scrollbox>
  );
}
