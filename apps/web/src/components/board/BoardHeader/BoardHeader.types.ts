/** Prop types for the BoardHeader. The appearance + auto-loop chrome cluster
 *  comes from `BoardChromeContext` (`useBoardChrome()`) and the Refresh handler
 *  from `WorktreesContext` — only board-owned view state travels as props. */
import type { BoardAppearance } from '@/lib/bridge';

/** Props for the board header: the title chip inputs, the controlled search
 *  (state owned by the Board's view hook, so the columns derive from the same
 *  value), and the appearance view the Background panel edits (owned by Board —
 *  it styles the whole board surface). */
export interface BoardHeaderProps {
  /** Total task count for the header's count chip. */
  taskCount: number;
  /** Active project name + path + branch for the subtitle (and the inspector). */
  projectName: string;
  projectPath: string;
  projectBranch: string | null;
  /** The controlled search query. */
  search: string;
  /** Update the search query (urgent update; the board defers the recompute). */
  onSearchChange: (value: string) => void;
  /** Open the New Task dialog. */
  onNewTask: () => void;
  /** The board's normalized appearance (the Background panel renders + edits it). */
  appearance: BoardAppearance;
  /** The loaded background image as a data: URL, or `null` when none is set. */
  backgroundUrl: string | null;
}
