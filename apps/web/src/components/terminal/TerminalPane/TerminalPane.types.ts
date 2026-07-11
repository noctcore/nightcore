/** Props for the {@link TerminalPane}. */
import type { TerminalSessionInfo } from '@/lib/bridge';

/** The task-link / governance chrome for a pane (cockpit spec PR 4, decisions 2 & 3):
 *  the ungoverned marker, the linked-task chip + clear affordance, and the one-click
 *  Claude launch. Bundled into one prop so the pane's contract stays slim. */
export interface TerminalPaneLink {
  /** Whether this session is ungoverned (task-linked or Claude-launched, decision 3). */
  ungoverned: boolean;
  /** The linked task's title, or `null` when unlinked (the decision 2 chip). */
  linkedTitle: string | null;
  /** Whether the composed `claude` launch is available (POSIX shell only, decision 3). */
  canLaunchClaude: boolean;
  /** Launch `claude` in this terminal (decision 3). */
  onLaunchClaude: () => void;
  /** Clear this terminal's task link (the decision 2 clear/switch affordance). */
  onClearLink: () => void;
}

/** Props for the xterm host pane. The pane renders the identity chrome + the
 *  terminal surface for ONE session; the live xterm instance is owned by the
 *  feature's session manager (kept alive across remounts) and attached here. */
export interface TerminalPaneProps {
  /** The session this pane displays. */
  session: TerminalSessionInfo;
  /** Whether a dragged file is currently over this pane (round-2 PR C): shows the
   *  drop-hint overlay. Dropping types the file's shell-escaped absolute path. */
  isDropTarget: boolean;
  /** Rename this session (decision 5): double-click the header title → inline edit.
   *  The parent optimistically updates + persists; empty clears back to the cwd
   *  leaf. */
  onRename: (id: string, title: string) => void;
  /** Task-link + governance chrome for this session (decisions 2 & 3). */
  link: TerminalPaneLink;
}
