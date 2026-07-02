/** The shared category/lens tab strip (semantic `role="tablist"`, mirroring the
 *  worktree switcher pattern). Each tab shows its label, an open-finding count,
 *  and a live pulse while its pass runs. Feature wrappers resolve their own
 *  metadata (labels, glyphs, the list/error labels) and pass it in. */
import { rovingKeydown } from '@/lib/roving-keydown';

import type { CategoryTabsShellProps } from './CategoryTabsShell.types';

export function CategoryTabsShell<K extends string>({
  tabs,
  active,
  onSelect,
  listLabel,
  errorLabel,
}: CategoryTabsShellProps<K>) {
  return (
    <div
      role="tablist"
      aria-label={listLabel}
      className="flex flex-wrap items-center gap-1 border-b border-border px-6 py-2"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.key}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-busy={tab.running}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={rovingKeydown}
            onClick={() => onSelect(tab.key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              isActive
                ? 'bg-primary/[0.12] text-primary'
                : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
            }`}
          >
            {Icon !== null && <Icon size={13} />}
            {tab.label}
            {tab.running ? (
              <span
                aria-hidden
                className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
              />
            ) : tab.count > 0 ? (
              <span
                className={`ml-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
                  isActive
                    ? 'bg-primary/20 text-primary'
                    : 'bg-white/[0.06] text-muted-foreground'
                }`}
              >
                {tab.count}
              </span>
            ) : tab.errored ? (
              <span
                aria-label={errorLabel}
                className="ml-0.5 text-[10px] font-semibold text-destructive"
              >
                !
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
