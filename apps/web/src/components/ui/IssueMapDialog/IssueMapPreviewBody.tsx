/** The IssueMapDialog's preview body: the deterministic group-count chips, the
 *  full rendered parent markdown, the complete list of sub-issue titles, the
 *  supersede link + opt-in "close the old map" checkbox, and the soft >50
 *  warning + fail-open-narrative note. Purely presentational — all state lives in
 *  the dialog's hooks. */
import type { IssueMapPreview } from '@/lib/bridge';

import { Checkbox } from '../Checkbox';
import { AlertIcon, ExternalLinkIcon } from '../icons';
import { Markdown } from '../Markdown';

const LABEL_CLASS = 'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';

interface IssueMapPreviewBodyProps {
  preview: IssueMapPreview;
  /** The opt-in supersede-close checkbox state (only meaningful when a prior map
   *  exists). */
  closeSuperseded: boolean;
  onToggleCloseSuperseded: (v: boolean) => void;
  /** True while the export is in flight — the checkbox locks. */
  disabled: boolean;
}

export function IssueMapPreviewBody({
  preview,
  closeSuperseded,
  onToggleCloseSuperseded,
  disabled,
}: IssueMapPreviewBodyProps) {
  const supersedes = preview.supersedes;
  return (
    <div className="flex flex-col gap-4">
      {preview.softWarning !== null && (
        <div className="flex items-start gap-2 rounded-[8px] border border-amber-500/40 bg-amber-500/[0.1] px-3 py-2 text-xs-plus text-amber-200">
          <AlertIcon size={14} className="mt-0.5 shrink-0" />
          <span>{preview.softWarning}</span>
        </div>
      )}

      {!preview.narrativeOk && (
        <p className="text-2xs leading-snug text-muted-foreground">
          The executive summary uses a deterministic template — the AI summary step was
          skipped or unavailable. Structure, counts, and titles are unaffected.
        </p>
      )}

      {/* Deterministic grouping chips. */}
      <div className="flex flex-col gap-1.5">
        <span className={LABEL_CLASS}>
          {preview.total} {preview.total === 1 ? 'finding' : 'findings'} ·{' '}
          {preview.groups.length} {preview.groups.length === 1 ? 'group' : 'groups'}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {preview.groups.map((g) => (
            <span
              key={g.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white/[0.03] px-2.5 py-0.5 text-2xs-plus text-foreground"
            >
              {g.label}
              <span className="rounded-full bg-white/[0.06] px-1.5 text-3xs font-semibold tabular-nums text-muted-foreground">
                {g.count}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* The full parent body — rendered exactly as it will post. */}
      <div className="flex flex-col gap-1.5">
        <span className={LABEL_CLASS}>Parent issue</span>
        <div className="max-h-[34vh] overflow-y-auto rounded-[10px] border border-border bg-black/20 px-3.5 py-3">
          <Markdown>{preview.parentBody}</Markdown>
        </div>
      </div>

      {/* Every sub-issue title, in the deterministic order. */}
      <div className="flex flex-col gap-1.5">
        <span className={LABEL_CLASS}>
          Sub-issues ({preview.subIssues.length})
        </span>
        <ul className="max-h-[28vh] divide-y divide-border overflow-y-auto rounded-[10px] border border-border bg-black/10">
          {preview.subIssues.map((sub, i) => (
            <li
              key={`${sub.title}-${i}`}
              className="flex items-start justify-between gap-3 px-3 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs-plus text-foreground">
                {sub.title}
              </span>
              <span className="shrink-0 font-mono text-3xs uppercase tracking-[0.08em] text-muted-foreground">
                {sub.groupLabel}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {supersedes !== null && (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-white/[0.02] px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs-plus text-muted-foreground">
            <span>Supersedes</span>
            <a
              href={supersedes.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              #{supersedes.number}
              <ExternalLinkIcon size={11} />
            </a>
            <span className="truncate">{supersedes.title}</span>
          </div>
          <Checkbox
            checked={closeSuperseded}
            onChange={onToggleCloseSuperseded}
            label={`Close the superseded map #${supersedes.number} and its open sub-issues`}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
