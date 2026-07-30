/**
 * VALIDATOR-DROP VISIBILITY (#197 slice 3): a collapsed "dropped by the validator (N)"
 * disclosure listing the candidate findings the adversarial validator judged
 * unsupported by the PR diff.
 *
 * The validator is fail-open by design — it only ever removes findings when it returns
 * a clean drop-list — but a clean-looking drop-list is exactly where a TRUE positive
 * disappears without a trace. Surfacing what it dropped turns a silent deletion into an
 * auditable one.
 *
 * Read-only by construction: these findings carry no lifecycle actions, no selection
 * checkbox, and never reach a posted review. Self-hides when nothing was dropped.
 */
import { ChevronDownIcon, ChevronRightIcon } from '@/components/ui';

import { LENS_META, SEVERITY_META } from '../prreview.constants';
import { useDropsCollapse } from './ValidatorDrops.hooks';
import type { ValidatorDropsProps } from './ValidatorDrops.types';

export function ValidatorDrops({ dropped }: ValidatorDropsProps) {
  const collapse = useDropsCollapse();
  if (dropped.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-nc border border-border bg-white/[0.015] px-4 py-2.5">
      <button
        type="button"
        onClick={collapse.toggle}
        aria-expanded={collapse.expanded}
        className="flex w-fit items-center gap-1.5 text-2xs-plus font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {collapse.expanded ? (
          <ChevronDownIcon size={12} />
        ) : (
          <ChevronRightIcon size={12} />
        )}
        Dropped by the validator ({dropped.length})
      </button>

      {collapse.expanded && (
        <div className="flex flex-col gap-2">
          <p className="text-2xs-plus leading-relaxed text-muted-foreground">
            The adversarial validator judged these unsupported by the PR diff, so they
            are not part of the review. They are listed here so a real finding can&apos;t
            vanish silently — re-run the review if one looks wrong.
          </p>
          <ul className="flex flex-col gap-1.5">
            {dropped.map((finding) => {
              const sev = SEVERITY_META[finding.severity];
              return (
                <li
                  key={finding.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xs-plus text-muted-foreground"
                >
                  <span
                    className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-3xs font-semibold ${sev.chip} ${sev.tone}`}
                  >
                    {sev.label}
                  </span>
                  <span className="font-mono text-3xs text-muted-foreground/80">
                    {LENS_META[finding.lens].label}
                  </span>
                  <span className="text-foreground/80">{finding.title}</span>
                  <span className="font-mono text-3xs text-muted-foreground/70">
                    {finding.line !== null
                      ? `${finding.file}:${finding.line}`
                      : finding.file}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
