import {
  Button,
  ConfirmDialog,
  EmptyState,
  FolderBrowserDialog,
  TerminalIcon,
} from '@/components/ui';
import { useWorktreesContext } from '@/lib/worktrees-context';

import { CreateWorktreeDialog } from '../CreateWorktreeDialog';
import { NewTabPicker } from '../NewTabPicker';
import { TerminalGrid } from '../TerminalGrid';
import { TerminalPane } from '../TerminalPane';
import { TerminalReadonlyPane } from '../TerminalReadonlyPane';
import { TerminalTabs } from '../TerminalTabs';
import { TerminalTaskMenu } from '../TerminalTaskMenu';
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
  fontSize,
  scrollback,
  tasks,
  yoloLaunch,
  onConfinedDefaultChange,
}: TerminalViewProps) {
  const { worktrees } = useWorktreesContext();
  const v = useTerminalView({
    projectPath,
    projectName,
    worktrees,
    webglEnabled,
    confinedDefault,
    fontSize,
    scrollback,
    tasks,
    yoloLaunch,
    onConfinedDefaultChange,
  });
  // Ids never collide (a restored session is dead), so the active tab is exactly one
  // of these — or neither, which lands on the empty state.
  const activeLive = v.sessions.find((s) => s.id === v.activeId) ?? null;
  const activeRestored = v.restored.find((r) => r.id === v.activeId) ?? null;
  // Grid mode shows every live pane at once (decision 1, PR 2). Restored (read-only)
  // tabs stay tab-only — selecting one drops back to the single-pane body even in
  // grid mode, and an empty live set falls through to the restore/empty body.
  const showGrid =
    v.layout.mode === 'grid' && v.layout.orderedSessions.length > 0 && activeRestored === null;

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
        onRename={v.renameSession}
        unread={v.unread}
        viewMode={v.layout.mode}
        onToggleViewMode={v.layout.toggleMode}
        ungovernedIds={v.tasks.ungovernedIds}
        headerSlot={
          <TerminalTaskMenu
            tasks={v.tasks.pickableTasks}
            activeSession={activeLive}
            onPick={v.tasks.injectTask}
          />
        }
      />

      {showGrid ? (
        <TerminalGrid
          sessions={v.layout.orderedSessions}
          unread={v.unread}
          ungovernedIds={v.tasks.ungovernedIds}
          canLaunchClaude={v.tasks.canLaunchClaude}
          zoomedId={v.layout.zoomedId}
          onRename={v.renameSession}
          onLaunchClaude={v.tasks.launchClaude}
          onReorder={v.layout.reorder}
          onToggleZoom={v.layout.toggleZoom}
          onActivate={v.selectTab}
        />
      ) : activeLive !== null ? (
        <TerminalPane
          key={activeLive.id}
          session={activeLive}
          onRename={v.renameSession}
          link={{
            ungoverned: v.tasks.ungovernedIds.has(activeLive.id),
            linkedTitle: v.tasks.linkedTitleBySession.get(activeLive.id) ?? null,
            canLaunchClaude: v.tasks.canLaunchClaude(activeLive),
            onLaunchClaude: () => v.tasks.launchClaude(activeLive),
            onClearLink: () => v.tasks.clearLink(activeLive.id),
          }}
        />
      ) : activeRestored !== null ? (
        <TerminalReadonlyPane
          key={activeRestored.id}
          info={activeRestored}
          canRestore={v.restore.canRestore(activeRestored.cwd)}
          onRestore={() => void v.restore.startFresh(activeRestored)}
          onResumeClaude={() => void v.tasks.resumeClaude(activeRestored)}
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
        onBrowse={v.picker.onBrowse}
        onCreateWorktree={v.picker.onCreateWorktree}
        onClose={v.picker.closePicker}
        error={v.picker.error}
        busy={v.picker.busy}
        confinedAvailable={v.picker.confinedAvailable}
        confined={v.picker.confined}
        onConfinedChange={v.picker.onConfinedChange}
      />

      <CreateWorktreeDialog
        open={v.createWorktree.open}
        branches={v.createWorktree.branches}
        busy={v.createWorktree.busy}
        error={v.createWorktree.error}
        onConfirm={(req) => void v.createWorktree.submit(req)}
        onClose={v.createWorktree.closeCreate}
      />

      <FolderBrowserDialog
        open={v.browse.open}
        initialPath={v.browse.initialPath}
        onClose={v.browse.close}
        onSelect={(path) => void v.browse.pick(path)}
        title="Open a terminal here"
        description="Pick any folder — your shell runs there with full permissions."
        selectLabel="Open terminal here"
        recentsKey="nc:terminal:recent-folders"
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
