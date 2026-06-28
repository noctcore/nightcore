/** The category tab strip for the Insight results view. */
import { CATEGORY_META } from '../insight.constants';
import type { CategoryTabsProps } from './CategoryTabs.types';

/** The category tab strip (semantic `role="tablist"`, mirroring the worktree
 *  switcher pattern). Each tab shows its label, an open-finding count, and a live
 *  pulse while its pass runs. */
export function CategoryTabs({ tabs, active, onSelect }: CategoryTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Finding categories"
      className="flex flex-wrap items-center gap-1 border-b border-border px-6 py-2"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        const label = tab.key === 'all' ? 'All' : CATEGORY_META[tab.key].label;
        const Icon = tab.key === 'all' ? null : CATEGORY_META[tab.key].icon;
        return (
          <button
            key={tab.key}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-busy={tab.running}
            onClick={() => onSelect(tab.key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              isActive
                ? 'bg-primary/[0.12] text-primary'
                : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
            }`}
          >
            {Icon !== null && <Icon size={13} />}
            {label}
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
              <span aria-label="analysis failed" className="ml-0.5 text-[10px] font-semibold text-destructive">
                !
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
