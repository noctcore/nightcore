import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  IconButton,
  SearchIcon,
} from '@/components/ui';

import { useTerminalSearchBar } from './TerminalSearchBar.hooks';
import type { TerminalSearchBarProps } from './TerminalSearchBar.types';

/** The in-pane search-in-scrollback bar (spec PR 3c): a compact find field over the
 *  session's `@xterm/addon-search`. Opened with ⌘F on the pane, it searches as you
 *  type; Enter / Shift+Enter (and the ‹ › buttons) step matches; Esc (or ×) closes.
 *  A thin shell — focus + key handling live in `useTerminalSearchBar`, and the search
 *  itself in the shared `useTerminalSearch` hook. */
export function TerminalSearchBar({
  query,
  noMatch,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: TerminalSearchBarProps) {
  const { inputRef, onInputKeyDown } = useTerminalSearchBar({ onNext, onPrev, onClose });
  return (
    <div
      role="search"
      className={`flex items-center gap-1 rounded-md border bg-black/70 px-1.5 py-1 shadow-lg backdrop-blur-sm ${
        noMatch ? 'border-destructive/70' : 'border-border'
      }`}
    >
      <SearchIcon size={12} className="shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        aria-label="Search terminal scrollback"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder="Find"
        className={`w-32 bg-transparent text-xs-flat outline-none placeholder:text-muted-foreground/60 ${
          noMatch ? 'text-destructive' : 'text-foreground'
        }`}
      />
      <IconButton label="Previous match (Shift+Enter)" onClick={onPrev} className="shrink-0">
        <ChevronLeftIcon size={13} />
      </IconButton>
      <IconButton label="Next match (Enter)" onClick={onNext} className="shrink-0">
        <ChevronRightIcon size={13} />
      </IconButton>
      <IconButton label="Close search (Esc)" onClick={onClose} className="shrink-0">
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
}
