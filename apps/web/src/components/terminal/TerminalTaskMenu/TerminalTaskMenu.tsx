import { BuildIcon, ChevronDownIcon, Menu } from '@/components/ui';

import { useTerminalTaskMenuItems } from './TerminalTaskMenu.hooks';
import type { TerminalTaskMenuProps } from './TerminalTaskMenu.types';

const TRIGGER_CLASS =
  'my-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

/** The header task dropdown (cockpit spec PR 4, decision 2): picks a backlog task to
 *  inject its context (title + description + on-disk JSON path) into the active
 *  terminal. A USER gesture — no agent-reachable path reaches this. Disabled (a plain
 *  button, no menu) when there is no active terminal to inject into. */
export function TerminalTaskMenu(props: TerminalTaskMenuProps) {
  const items = useTerminalTaskMenuItems(props);
  const disabled = props.activeSession === null;
  const trigger = (
    <button
      type="button"
      disabled={disabled}
      title={
        disabled
          ? 'Open a terminal to inject a task'
          : "Inject a task's context (title, description, file path) into this terminal"
      }
      className={TRIGGER_CLASS}
    >
      <BuildIcon size={13} aria-hidden />
      <span>Inject task</span>
      <ChevronDownIcon size={12} aria-hidden />
    </button>
  );
  if (disabled) return trigger;
  return <Menu trigger={trigger} label="Inject a task into the terminal" items={items} align="right" />;
}
