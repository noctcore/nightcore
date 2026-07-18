import { SearchIcon } from '../icons/icons';
import { projectIconComponent } from '../ProjectIcon/ProjectIcon.icons';
import { useIconPicker } from './IconPicker.hooks';
import type { IconPickerProps } from './IconPicker.types';

/** Searchable grid of curated Lucide project icons. */
export function IconPicker({ selectedIcon, onSelectIcon }: IconPickerProps) {
  const { query, setQuery, filtered } = useIconPicker();

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons…"
          aria-label="Search icons"
          className="w-full rounded-nc border border-border bg-black/20 py-2 pl-8 pr-2.5 text-xs-plus2 text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
        />
      </div>
      <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto rounded-nc border border-border bg-black/10 p-1.5">
        {filtered.map((name) => {
          const Lucide = projectIconComponent(name);
          if (Lucide === null) return null;
          const selected = selectedIcon === name;
          return (
            <button
              key={name}
              type="button"
              title={name}
              aria-label={name}
              aria-pressed={selected}
              onClick={() => onSelectIcon(selected ? null : name)}
              className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                selected
                  ? 'bg-primary/20 text-primary ring-1 ring-primary/40'
                  : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
              }`}
            >
              <Lucide size={18} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
