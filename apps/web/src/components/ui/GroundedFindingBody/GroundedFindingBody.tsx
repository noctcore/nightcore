/**
 * The shared grounded-finding detail sheet: {@link DetailPanelShell} plus the
 * body sections every scan family's detail panel had re-cloned — description /
 * location / rationale / suggested fix / before-after code / affected files /
 * tags — with the `useLastPresent` keep-content-while-animating-out handling
 * and the empty-shell branch owned here. Families contribute only their badge
 * row, footer actions, and any extra sections via the slot seams.
 */
import { Button } from '../Button';
import { CodeBlock } from '../CodeBlock';
import {
  DetailLocation,
  DetailPanelShell,
  DetailSection,
} from '../DetailPanelShell';
import { MoveIcon, RetryIcon, TrashIcon } from '../icons';
import { Markdown } from '../Markdown';
import { useLastPresent } from '../Modal';
import type {
  GroundedFindingBodyProps,
  GroundedLifecycleFooterProps,
} from './GroundedFindingBody.types';

/** Infer a syntax-highlight language from a grounded file's extension,
 *  defaulting to `ts`. CodeBlock maps anything it doesn't know to plain text. */
export function inferLanguageFromFile(file: string | null | undefined): string {
  const ext = file?.split('.').pop()?.toLowerCase();
  return ext !== undefined && ext.length > 0 ? ext : 'ts';
}

export function GroundedFindingBody<T>({
  open,
  item,
  onClose,
  wide,
  render,
}: GroundedFindingBodyProps<T>) {
  // Retain the last item so the sheet keeps its content while it animates out.
  const shown = useLastPresent(item);
  if (shown === null) {
    return (
      <DetailPanelShell
        open={false}
        label=""
        onClose={onClose}
        title=""
        badges={null}
        footer={null}
        wide={wide}
      >
        {null}
      </DetailPanelShell>
    );
  }

  const view = render(shown);
  const s = view.sections;
  const lang = s.language ?? 'ts';

  return (
    <DetailPanelShell
      open={open}
      label={view.label ?? view.title}
      onClose={onClose}
      title={view.title}
      headerLead={view.headerLead}
      badges={view.badges}
      footer={view.footer}
      wide={wide}
    >
      {s.lead}

      <DetailSection title={s.descriptionTitle ?? 'What'}>
        {s.descriptionInert === true ? (
          // Model-authored body — rendered as inert text, never as HTML/Markdown.
          <p className="whitespace-pre-wrap text-xs-plus2 leading-relaxed text-foreground">
            {s.description}
          </p>
        ) : (
          <Markdown>{s.description}</Markdown>
        )}
      </DetailSection>

      {s.afterDescription}

      {s.location != null && (
        <DetailSection title="Location">
          <DetailLocation>{s.location}</DetailLocation>
        </DetailSection>
      )}

      {s.rationale != null && (
        <DetailSection title={s.rationaleTitle ?? 'Why it matters'}>
          <Markdown>{s.rationale}</Markdown>
        </DetailSection>
      )}

      {s.suggestion != null && (
        <DetailSection title={s.suggestionTitle ?? 'Suggested fix'}>
          {s.suggestionCode === true ? (
            <CodeBlock code={s.suggestion} language={lang} />
          ) : (
            <Markdown>{s.suggestion}</Markdown>
          )}
        </DetailSection>
      )}

      {s.codeBefore != null && (
        <DetailSection title="Before">
          <CodeBlock code={s.codeBefore} language={lang} />
        </DetailSection>
      )}
      {s.codeAfter != null && (
        <DetailSection title="After">
          <CodeBlock
            code={s.codeAfter}
            language={lang}
            className="border-success/30 bg-success/[0.06]"
          />
        </DetailSection>
      )}

      {s.extra}

      {s.affectedFiles !== undefined && s.affectedFiles.length > 0 && (
        <DetailSection title="Affected files">
          <ul className="flex flex-col gap-1">
            {s.affectedFiles.map((f) => (
              <li key={f}>
                <code className="font-mono text-2xs-plus text-muted-foreground">
                  {f}
                </code>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {s.tags !== undefined && s.tags.length > 0 && (
        <DetailSection title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {s.tags.map((t) => (
              <span
                key={t}
                className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </DetailSection>
      )}
    </DetailPanelShell>
  );
}

/** The shared footer lifecycle triple: converted → "Go to task"; open →
 *  "Convert to task" + "Dismiss"; dismissed → disabled convert + "Restore". */
export function GroundedLifecycleFooter({
  status,
  pending,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: GroundedLifecycleFooterProps) {
  return (
    <>
      {status === 'converted' ? (
        <Button variant="secondary" disabled={pending} onClick={onGotoBoard}>
          <MoveIcon size={15} />
          Go to task
        </Button>
      ) : (
        <Button busy={pending} disabled={status === 'dismissed'} onClick={onConvert}>
          {!pending && <MoveIcon size={15} />}
          Convert to task
        </Button>
      )}

      {status === 'dismissed' ? (
        <Button variant="ghost" disabled={pending} onClick={onRestore}>
          <RetryIcon size={15} />
          Restore
        </Button>
      ) : (
        status !== 'converted' && (
          <Button variant="ghost" disabled={pending} onClick={onDismiss}>
            <TrashIcon size={15} />
            Dismiss
          </Button>
        )
      )}
    </>
  );
}
