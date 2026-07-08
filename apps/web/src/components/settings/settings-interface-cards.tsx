/** Interface settings cards — split from settings-cards to stay under file-size ratchet. */
import { Columns2Icon, DesignIcon, PanelLeftIcon } from '@/components/ui';
import type { Settings } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';

type SidebarStyle = 'unified' | 'classic';

function sidebarStyleCardClass(selected: boolean): string {
  const base =
    'group flex flex-col items-center gap-3 rounded-xl p-4 text-sm font-medium transition-all duration-200 ease-out hover:scale-[1.02] active:scale-[0.98]';
  if (selected) {
    return `${base} border-2 border-primary/40 bg-gradient-to-br from-primary/15 to-primary/10 text-foreground shadow-md shadow-primary/10`;
  }
  return `${base} border border-border/50 bg-accent/30 text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground hover:shadow-sm`;
}

function SidebarLayoutPicker({
  value,
  onChange,
}: {
  value: SidebarStyle;
  onChange: (next: SidebarStyle) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <button
        type="button"
        onClick={() => onChange('unified')}
        className={sidebarStyleCardClass(value === 'unified')}
        aria-pressed={value === 'unified'}
      >
        <PanelLeftIcon
          size={32}
          className={`transition-all duration-200 ${value === 'unified' ? 'text-primary' : 'text-muted-foreground'}`}
        />
        <div className="text-center">
          <div className="font-medium">Unified</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Single sidebar with project dropdown
          </div>
        </div>
      </button>

      <button
        type="button"
        onClick={() => onChange('classic')}
        className={sidebarStyleCardClass(value === 'classic')}
        aria-pressed={value === 'classic'}
      >
        <Columns2Icon
          size={32}
          className={`transition-all duration-200 ${value === 'classic' ? 'text-primary' : 'text-muted-foreground'}`}
        />
        <div className="text-center">
          <div className="font-medium">Classic</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Separate project switcher + sidebar
          </div>
        </div>
      </button>
    </div>
  );
}

/** Build the Interface page cards (sidebar layout). */
export function buildInterfaceCards(
  settings: Settings,
  patchGlobal: (patch: { sidebarStyle: string }) => void,
): SettingsCardProps[] {
  const value: SidebarStyle = settings.sidebarStyle === 'classic' ? 'classic' : 'unified';

  return [
    {
      icon: <DesignIcon size={18} />,
      title: 'Appearance',
      subtitle: 'Sidebar layout for the workspace chrome.',
      rows: [
        {
          label: 'Sidebar layout',
          hint: 'Choose between a modern unified sidebar or classic layout with a separate project switcher.',
          stacked: true,
          control: (
            <SidebarLayoutPicker
              value={value}
              onChange={(next) => patchGlobal({ sidebarStyle: next })}
            />
          ),
        },
      ],
    },
  ];
}
