import type { ReactNode } from 'react';
import type { PaletteEntry } from '../commands/palette.js';

interface CommandPaletteProps {
  entries: PaletteEntry[];
  /** Index of the highlighted entry; App moves it with ↑/↓. */
  highlighted: number;
}

/**
 * The slash-command autocomplete dropdown, rendered ABOVE the input while the
 * buffer is a bare `/name` (no space yet). Pure presentation: App owns the buffer,
 * the match list, the highlight index, and the Tab/↑/↓/Enter routing — this just
 * paints the current state.
 *
 * The list is virtualized to a small window around the highlight so a large SDK
 * command set never overflows the terminal.
 */
const MAX_VISIBLE = 8;

export function CommandPalette({
  entries,
  highlighted,
}: CommandPaletteProps): ReactNode {
  if (entries.length === 0) return null;

  // Scroll a fixed window so the highlight stays visible without growing the box.
  const start = Math.max(
    0,
    Math.min(highlighted - (MAX_VISIBLE - 1), entries.length - MAX_VISIBLE),
  );
  const visible = entries.slice(start, start + MAX_VISIBLE);

  return (
    <box
      title="commands — tab complete · ↑↓ move · enter run · esc close"
      style={{
        border: true,
        borderColor: '#5fafff',
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {visible.map((entry, i) => {
        const index = start + i;
        const active = index === highlighted;
        return (
          <text key={`${entry.source}-${entry.name}`}>
            <span fg={active ? '#5fafff' : '#666666'}>
              {active ? '› ' : '  '}
            </span>
            <span fg={active ? '#ffffff' : '#cfd8e3'}>/{entry.name}</span>
            <span fg="#666666">
              {'  '}
              {entry.description}
            </span>
          </text>
        );
      })}
    </box>
  );
}
