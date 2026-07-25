/** Integrated toolbar feature pill: icon, label, inline switch, optional settings. */
import { useToolbarOptionSettings } from './ToolbarOption.hooks';
import { InlineSwitch, SettingsTrigger } from './ToolbarOption.parts';
import type { ToolbarOptionProps } from './ToolbarOption.types';

/** A toolbar feature control in one pill — label + toggle on the left, optional
 *  settings trigger on the right. */
export function ToolbarOption({
  label,
  on,
  onToggle,
  icon,
  badge,
  title,
  settingsLabel,
  settingsIcon,
  settings,
  className,
}: ToolbarOptionProps) {
  const hasSettings = settings !== undefined;
  const resolvedSettingsLabel = settingsLabel ?? `${label} options`;
  const { open, toggle, rootRef, triggerRef } = useToolbarOptionSettings();

  return (
    <div ref={rootRef} className={`relative inline-flex ${className ?? ''}`}>
      <div
        className={`inline-flex items-stretch overflow-hidden rounded-nc border text-xs-plus font-semibold text-foreground transition-colors ${
          on
            ? 'border-primary/55 bg-primary/[0.12]'
            : 'border-border bg-white/[0.02] hover:border-white/20'
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={on}
          title={title}
          className="flex items-center gap-2.5 px-3.5 py-1.5 transition-colors"
        >
          {icon}
          <span>{label}</span>
          {badge}
          <InlineSwitch on={on} />
        </button>
        {hasSettings && (
          <SettingsTrigger
            ref={triggerRef}
            open={open}
            label={resolvedSettingsLabel}
            icon={settingsIcon}
            onClick={toggle}
          />
        )}
      </div>
      {hasSettings && open && (
        <div
          role="group"
          aria-label={resolvedSettingsLabel}
          className="nc-popover-rise absolute right-0 top-full z-20 mt-1.5 w-72 rounded-nc border border-border bg-popover p-3 shadow-2xl"
        >
          {settings}
        </div>
      )}
    </div>
  );
}
