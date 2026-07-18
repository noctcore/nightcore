/** Props for the {@link TerminalSearchBar} — the in-pane search-in-scrollback bar
 *  (spec PR 3c). Presentational over the shared `useTerminalSearch` state. */
export interface TerminalSearchBarProps {
  /** The current query. */
  query: string;
  /** True when a non-empty query matched nothing (drives the no-results style). */
  noMatch: boolean;
  /** The active match index (`-1` when none is selected), for the "n/m" counter. */
  resultIndex: number;
  /** The total match count in the scrollback, for the "n/m" counter. */
  resultCount: number;
  /** Update the query (re-runs an incremental search). */
  onQueryChange: (value: string) => void;
  /** Jump to the next match (Enter / › button). */
  onNext: () => void;
  /** Jump to the previous match (Shift+Enter / ‹ button). */
  onPrev: () => void;
  /** Close the bar (Esc / × button). */
  onClose: () => void;
}
