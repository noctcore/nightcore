/** The push-gate TRUST VIEW: the local fix commit's REAL diff — a git summary
 *  line over an expandable changed-file list, each row lazily revealing its
 *  unified-diff patch — so the human approves the actual change, not the model's
 *  prose summary (T10 governed-autonomy gap). Self-fetches from the pr-fix diff
 *  bridge (fetchers injectable for stories/tests); renders a quiet note while
 *  loading, on error, or when there is nothing to show (also the non-Tauri case). */
import { ChevronRightIcon, CodeBlock, Spinner } from '@/components/ui';
import { prFixDiff, prFixFileDiff } from '@/lib/bridge';

import { STATUS_LETTER, useFixDiff } from './FixDiffPreview.hooks';
import type { FixDiffPreviewProps } from './FixDiffPreview.types';

export function FixDiffPreview({
  fixId,
  fetchDiff = prFixDiff,
  fetchPatch = prFixFileDiff,
}: FixDiffPreviewProps) {
  const { loading, error, summary, files, expandedPath, patch, patchLoading, toggle } =
    useFixDiff(fixId, fetchDiff, fetchPatch);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[8px] border border-border bg-black/20 px-3 py-2 text-xs-flat text-muted-foreground">
        <Spinner size={13} />
        Loading the fix diff…
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="rounded-[8px] border border-border bg-black/20 px-3 py-2 text-xs-flat text-muted-foreground">
        Could not load the fix diff: {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="rounded-[8px] border border-border bg-black/20 px-3 py-2 text-xs-flat text-muted-foreground">
        No file changes to preview in the fix commit.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] border border-border bg-black/20 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
          Fix diff — approve the real change
        </span>
        {summary.length > 0 && (
          <span className="font-mono text-2xs text-muted-foreground" title={summary}>
            {summary}
          </span>
        )}
      </div>
      <ul className="flex flex-col">
        {files.map((file) => {
          const open = expandedPath === file.path;
          return (
            <li key={file.path} className="flex flex-col">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(file.path)}
                className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
              >
                <ChevronRightIcon
                  size={12}
                  className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <span
                  aria-hidden
                  className="w-3 shrink-0 text-center font-mono text-2xs text-muted-foreground"
                >
                  {STATUS_LETTER[file.status]}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs-flat text-foreground">
                  {file.path}
                </span>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                  <span className="text-success">+{file.additions}</span>{' '}
                  <span className="text-destructive">-{file.deletions}</span>
                </span>
              </button>
              {open && (
                <div className="px-1.5 pb-1.5">
                  {patchLoading ? (
                    <div className="flex items-center justify-center py-3 text-muted-foreground">
                      <Spinner size={14} />
                    </div>
                  ) : patch !== null && patch.trim().length > 0 ? (
                    <div className="max-h-[320px] overflow-y-auto">
                      <CodeBlock code={patch} language="diff" />
                    </div>
                  ) : (
                    <p className="px-1 py-2 text-2xs-plus text-muted-foreground">
                      No textual changes to show.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
