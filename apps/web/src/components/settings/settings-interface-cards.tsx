/** Interface settings cards — split from settings-cards to stay under file-size ratchet. */
import {
  Columns2Icon,
  DesignIcon,
  NumberField,
  PanelLeftIcon,
  TerminalIcon,
  Toggle,
} from '@/components/ui';
import type { Settings, SettingsPatch } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';

type SidebarStyle = 'unified' | 'classic';

// Clamp bounds for the two terminal render prefs (spec PR 3d). Mirrors the terminal
// feature's own resolver (which re-clamps on apply) — kept inline here so a settings
// card never cross-feature-imports the terminal module. Font size in px; scrollback
// in lines.
const TERMINAL_FONT_SIZE = { min: 8, max: 32, default: 13 } as const;
const TERMINAL_SCROLLBACK = { min: 1_000, max: 100_000, default: 10_000 } as const;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

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

/** Build the Interface page cards (sidebar layout + terminal rendering). */
export function buildInterfaceCards(
  settings: Settings,
  patchGlobal: (patch: SettingsPatch) => void,
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
    {
      icon: <TerminalIcon size={18} />,
      title: 'Terminal',
      subtitle: 'How the integrated terminal renders its output.',
      rows: [
        {
          label: 'GPU rendering (WebGL)',
          hint: 'Use the GPU to draw the terminal. Off by default (standard DOM rendering); a lost GPU context falls back automatically.',
          control: (
            <Toggle
              on={settings.terminalWebglEnabled}
              onChange={(next) => patchGlobal({ terminalWebglEnabled: next })}
              label="GPU rendering (WebGL)"
            />
          ),
        },
        {
          label: 'Font size',
          hint: 'Terminal text size in pixels (empty = default 13). Applies to open terminals live.',
          control: (
            <NumberField
              value={settings.terminalFontSize}
              placeholder={String(TERMINAL_FONT_SIZE.default)}
              min={TERMINAL_FONT_SIZE.min}
              step="1"
              ariaLabel="Terminal font size in pixels"
              onCommit={(n) =>
                patchGlobal({
                  terminalFontSize: clampInt(n, TERMINAL_FONT_SIZE.min, TERMINAL_FONT_SIZE.max),
                })
              }
            />
          ),
        },
        {
          label: 'Scrollback',
          hint: 'Lines of history kept per terminal (empty = default 10,000). Applies to new output.',
          control: (
            <NumberField
              value={settings.terminalScrollback}
              placeholder={String(TERMINAL_SCROLLBACK.default)}
              min={TERMINAL_SCROLLBACK.min}
              step="1000"
              ariaLabel="Terminal scrollback length in lines"
              onCommit={(n) =>
                patchGlobal({
                  terminalScrollback: clampInt(
                    n,
                    TERMINAL_SCROLLBACK.min,
                    TERMINAL_SCROLLBACK.max,
                  ),
                })
              }
            />
          ),
        },
      ],
    },
  ];
}
