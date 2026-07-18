/** Presentational sub-parts for ToolbarOption. */
import { forwardRef, type ReactNode } from 'react';

import { GearIcon } from '../icons';

/** Props for {@link InlineSwitch}. */
interface InlineSwitchProps {
  on: boolean;
}

/** Decorative switch track used inside the toolbar toggle button. */
export function InlineSwitch({ on }: InlineSwitchProps) {
  return (
    <span
      aria-hidden
      className={`relative h-[17px] w-[30px] rounded-full transition-colors ${
        on ? 'bg-primary' : 'bg-white/[0.12]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-[13px] w-[13px] rounded-full bg-white transition-transform ${
          on ? 'left-[14px]' : 'left-0.5'
        }`}
      />
    </span>
  );
}

/** Props for {@link SettingsTrigger}. */
interface SettingsTriggerProps {
  open: boolean;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

/** The settings gear trigger at the right edge of the integrated pill. */
export const SettingsTrigger = forwardRef<HTMLButtonElement, SettingsTriggerProps>(
  function SettingsTrigger({ open, label, icon, onClick }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        aria-label={label}
        aria-expanded={open}
        title={label}
        className={`flex items-center justify-center rounded-r-[8px] border-l border-border/60 px-2 py-1.5 text-foreground transition-colors ${
          open
            ? 'bg-white/[0.04]'
            : 'hover:bg-white/[0.03]'
        }`}
      >
        {icon ?? <GearIcon size={15} className="text-muted-foreground" />}
      </button>
    );
  },
);
