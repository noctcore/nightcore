/** The drawer's Trust band (wayfinder #91) — a per-task governance receipt. Renders
 *  the structured `TrustReport` natively (summary + gauntlet/guardrail/flight
 *  sections), a one-click markdown Export (native save dialog → Rust atomic write),
 *  and a canonical-markdown Preview. Owns the report fetch + export/preview
 *  orchestration through `useTrustReport` (the usePrStatus lifted-fetch idiom); the
 *  band's visibility is gated in TaskDetail (only for a task that has run). */
import { BookIcon, Button, Markdown, Spinner, UploadIcon } from '@/components/ui';

import { useTrustReport } from './TrustReport.hooks';
import type { TrustReportProps } from './TrustReport.types';
import { TrustSections } from './TrustSections';
import { TrustSummary } from './TrustSummary';

export function TrustReport({ task, trustReport }: TrustReportProps) {
  const view = useTrustReport(task, trustReport);
  const { report, loading, unavailable, error, export: exp, preview } = view;

  if (report === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {loading
          ? 'Computing the trust report…'
          : error != null
            ? `Trust report failed: ${error}`
            : unavailable
              ? 'Trust report is unavailable in the browser preview.'
              : 'No trust report yet.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <TrustSummary report={report} />
      <TrustSections report={report} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={exp.run}
          disabled={exp.pending}
          aria-busy={exp.pending}
        >
          {exp.pending ? <Spinner size={14} /> : <UploadIcon size={14} />}
          {exp.pending ? 'Exporting…' : 'Export'}
        </Button>
        <Button variant="ghost" onClick={preview.toggle} aria-expanded={preview.open}>
          <BookIcon size={14} />
          {preview.open ? 'Hide preview' : 'Preview'}
        </Button>
      </div>

      {exp.error != null && (
        <p className="text-xs text-destructive">Export failed: {exp.error}</p>
      )}
      {exp.savedPath != null && (
        <p className="text-xs text-success">Saved to {exp.savedPath}</p>
      )}

      {preview.open && (
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          {preview.loading ? (
            <p className="text-sm text-muted-foreground">Rendering the receipt…</p>
          ) : preview.error != null ? (
            <p className="text-xs text-destructive">{preview.error}</p>
          ) : preview.markdown !== null && preview.markdown.length > 0 ? (
            <Markdown>{preview.markdown}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">
              Markdown preview is unavailable in the browser preview.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
