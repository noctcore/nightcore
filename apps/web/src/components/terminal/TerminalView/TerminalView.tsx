import { Button, ConfirmDialog, EmptyState, TerminalIcon } from '@/components/ui';
import { useWorktreesContext } from '@/lib/worktrees-context';

import { NewTabPicker } from '../NewTabPicker';
import { TerminalPane } from '../TerminalPane';
import { TerminalReadonlyPane } from '../TerminalReadonlyPane';
import { TerminalTabs } from '../TerminalTabs';
import { useTerminalView } from './TerminalView.hooks';
import type { TerminalViewProps } from './TerminalView.types';

/** The global Terminal view (decision 4): a first-class nav destination with a
 *  tabbed set of user shells, one active pane at a time. A thin shell — the tab /
 *  session / picker / restore orchestration lives in `useTerminalView`, and the live
 *  xterm instances are owned by the feature's session manager (so they survive this
 *  routed view's remount). Worktrees come from the shared context, the same source
 *  the Worktrees view uses. */
export function TerminalView({
  projectPath,
  projectName,
  webglEnabled,
  confinedDefault,
  onConfinedDefaultChange,
}: TerminalViewProps) {
  const { worktrees } = useWorktreesContext();
  const v = useTerminalView({
    projectPath,
    projectName,
    worktrees,
    webglEnabled,
    confinedDefault,
    onConfinedDefaultChange,
  });
  // Ids never collide (a restored session is dead), so the active tab is exactly one
  // of these — or neither, which lands on the empty state.
  const activeLive = v.sessions.find((s) => s.id === v.activeId) ?? null;
  const activeRestored = v.restored.find((r) => r.id === v.activeId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TerminalTabs
        sessions={v.sessions}
        restored={v.restored}
        activeId={v.activeId}
        onSelect={v.selectTab}
        onClose={v.requestClose}
        onDismiss={v.dismissRestored}
        onNewTab={v.picker.openPicker}
        canAddTab={v.canAddTab}
      />

      {activeLive !== null ? (
        <TerminalPane key={activeLive.id} session={activeLive} />
      ) : activeRestored !== null ? (
        <TerminalReadonlyPane
          key={activeRestored.id}
          info={activeRestored}
          canRestore={v.restore.canRestore(activeRestored.cwd)}
          onRestore={() => void v.restore.startFresh(activeRestored)}
        />
      ) : (
        <EmptyState
          icon={<TerminalIcon size={32} />}
          title="No terminals open"
          description="Open a shell in the repo root or a worktree — it runs with your full permissions, outside the agent guardrails."
          action={<Button onClick={v.picker.openPicker}>Open a terminal</Button>}
        />
      )}

      <NewTabPicker
        open={v.picker.open}
        targets={v.picker.targets}
        onPick={v.picker.pickTarget}
        onClose={v.picker.closePicker}
        error={v.picker.error}
        busy={v.picker.busy}
        confinedAvailable={v.picker.confinedAvailable}
        confined={v.picker.confined}
        onConfinedChange={v.picker.onConfinedChange}
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
