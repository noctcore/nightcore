/** Props for the DiffPatchView component. */

/** Props for the inline unified-diff patch renderer: the raw patch text for ONE
 *  changed file (or `null` before it has been fetched) plus the in-flight flag.
 *  Purely presentational — the parent (DiffViewDialog) owns the lazy
 *  `worktree_file_diff` fetch. */
export interface DiffPatchViewProps {
  /** The raw unified-diff patch text; `''` for an empty/absent diff, the
   *  `Binary file <path> (not shown)` sentinel for binaries, or `null` before the
   *  first fetch resolves. */
  patch: string | null;
  /** Show the spinner while the patch is being fetched. */
  loading?: boolean;
}
