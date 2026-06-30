/** Map a raw git / bridge error into friendly, human-readable toast copy.
 *  The Rust worktree layer surfaces trimmed git stderr; this turns the common
 *  cases into a clear title + detail rather than leaking raw `fatal:` lines. */
export interface FriendlyError {
  title: string;
  detail: string;
}

/** Strip a leading `fatal:` / `error:` prefix and keep the first line. */
function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.replace(/^(fatal:|error:)\s*/i, '').trim();
}

/** Translate a worktree/merge/git failure into `{ title, detail }`. */
export function parseGitError(error: unknown): FriendlyError {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (lower.includes('not verified')) {
    return {
      title: 'Task not verified',
      detail: 'A reviewer must pass this task before its branch can merge.',
    };
  }
  if (lower.includes('still running')) {
    return {
      title: 'Task is still running',
      detail: 'Stop the run before discarding its worktree.',
    };
  }
  if (lower.includes('conflict')) {
    return {
      title: 'Merge conflict',
      detail: 'Resolve the conflicting files in the worktree, commit, then merge again.',
    };
  }
  if (lower.includes('dirty')) {
    return {
      title: 'Base working tree is dirty',
      detail: 'Commit or stash changes on the base branch before merging.',
    };
  }
  if (lower.includes('already checked out') || lower.includes('already exists')) {
    return { title: 'Branch already in use', detail: firstLine(text) };
  }
  if (lower.includes('no worktree')) {
    return { title: 'No worktree yet', detail: 'Run this task first to create its worktree.' };
  }
  if (lower.includes('no active project')) {
    return { title: 'No active project', detail: 'Open a project first.' };
  }
  return { title: 'Git operation failed', detail: firstLine(text) || 'Unknown error.' };
}
