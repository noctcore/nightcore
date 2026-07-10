import { Button, ConfirmDialog, EmptyState, TerminalIcon } from '@/components/ui';
import { useWorktreesContext } from '@/lib/worktrees-context';

import { NewTabPicker } from '../NewTabPicker';
import { TerminalPane } from '../TerminalPane';
import { TerminalTabs } from '../TerminalTabs';
import { useTerminalView } from './TerminalView.hooks';
import type { TerminalViewProps } from './TerminalView.types';

/** The global Terminal view (decision 4): a first-class nav destination with a
 *  tabbed set of user shells, one active pane at a time. A thin shell — the tab /
 *  session / picker orchestration lives in `useTerminalView`, and the live xterm
 *  instances are owned by the feature's session manager (so they survive this
 *  routed view's remount). Worktrees come from the shared context, the same source
 *  the Worktrees view uses. */
export function TerminalView({ projectPath, projectName }: TerminalViewProps) {
  const { worktrees } = useWorktreesContext();
  const v = useTerminalView({ projectPath, projectName, worktrees });
  const active = v.sessions.find((s) => s.id === v.activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalTabs
        sessions={v.sessions}
        activeId={v.activeId}
        onSelect={v.selectTab}
        onClose={v.requestClose}
        onNewTab={v.openPicker}
        canAddTab={v.canAddTab}
      />

      {active !== null ? (
        <TerminalPane key={active.id} session={active} />
      ) : (
        <EmptyState
          icon={<TerminalIcon size={32} />}
          title="No terminals open"
          description="Open a shell in the repo root or a worktree — it runs with your full permissions, outside the agent guardrails."
          action={<Button onClick={v.openPicker}>Open a terminal</Button>}
        />
      )}

      <NewTabPicker
        open={v.pickerOpen}
        targets={v.targets}
        onPick={v.pickTarget}
        onClose={v.closePicker}
        error={v.spawnError}
        busy={v.busy}
      />

      <ConfirmDialog
        open={v.pendingClose !== null}
        title="Close terminal?"
        message="The shell and any processes running in it will end."
        confirmLabel="Close terminal"
        destructive
        onConfirm={v.confirmClose}
        onCancel={v.cancelClose}
      />
    </div>
  );
}
