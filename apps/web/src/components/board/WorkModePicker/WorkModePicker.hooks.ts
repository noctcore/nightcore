/** WorkModePicker helpers: the per-run-mode glyph. */
import { BoardIcon, DecomposeIcon } from '@/components/ui';
import type { RunMode } from '@/lib/bridge';

/** The glyph for a run mode: Main edits the board's project tree in place
 *  (board glyph); Worktree forks an isolated branch (fork glyph). */
export function runModeIcon(mode: RunMode): typeof BoardIcon {
  return mode === 'worktree' ? DecomposeIcon : BoardIcon;
}
