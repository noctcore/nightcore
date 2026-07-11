import { createElement, useMemo } from 'react';

import { BuildIcon, type MenuItem } from '@/components/ui';

import type { TerminalTaskMenuProps } from './TerminalTaskMenu.types';

/** Build the dropdown's menu items from the pickable tasks: each injects its context
 *  into the active session on click. An empty list yields a single inert "No backlog
 *  tasks" row so the menu never opens empty. Returns `[]` when there is no active
 *  session (the trigger renders disabled and the Menu is not mounted). */
export function useTerminalTaskMenuItems({
  tasks,
  activeSession,
  onPick,
}: TerminalTaskMenuProps): MenuItem[] {
  return useMemo(() => {
    if (activeSession === null) return [];
    if (tasks.length === 0) {
      return [{ label: 'No backlog tasks', icon: createElement(BuildIcon, { size: 14 }), onClick: () => {} }];
    }
    return tasks.map((task) => ({
      label: task.title || 'Untitled task',
      icon: createElement(BuildIcon, { size: 14 }),
      onClick: () => onPick(activeSession, task),
    }));
  }, [tasks, activeSession, onPick]);
}
