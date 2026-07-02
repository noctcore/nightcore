/** The Constitution editor card: view/edit and regenerate the project's injected context pack. */
import { BookIcon, Button, CodeBlock, RetryIcon, Spinner } from '@/components/ui';

import {
  EMPTY_PACK_PLACEHOLDER,
  MODE_TABS,
  PACK_LANGUAGE,
} from './ConstitutionCard.constants';
import { useConstitutionCard } from './ConstitutionCard.hooks';
import type { ConstitutionCardProps } from './ConstitutionCard.types';

/** A small toggle switch (shared visual with the settings Toggle). */
function RowToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full px-0.5 transition-colors ${on ? 'bg-primary' : 'bg-white/[0.12]'}`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : ''}`}
      />
    </button>
  );
}

/**
 * The Constitution editor: view/edit the curated `.nightcore/context.md` Nightcore
 * injects into every agent run, with a regenerate-from-sources action and a
 * per-project on/off toggle. Reuses `CodeBlock` for the preview and the Settings
 * card chrome for the shell.
 */
export function ConstitutionCard({
  enabled,
  onToggleEnabled,
  projectActive,
}: ConstitutionCardProps) {
  const {
    content,
    onContentChange,
    loading,
    busy,
    busyAction,
    dirty,
    mode,
    setMode,
    save,
    regenerate,
    error,
  } = useConstitutionCard(projectActive);

  return (
    <section className="mb-[18px] rounded-2xl border border-border bg-card px-[22px] pb-5 pt-[22px]">
      <div className="flex items-start gap-3.5 pb-1.5">
        <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-primary/[0.12] text-primary">
          <BookIcon size={18} />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="text-lg font-semibold tracking-tight">Project Constitution</h2>
          <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
            A trusted, Nightcore-controlled context pack injected into every agent run's
            system prompt — so agents start knowing the project's rules instead of
            rediscovering (or violating) them.
          </p>
        </div>
        <RowToggle
          on={enabled}
          onChange={onToggleEnabled}
          label="Inject the context pack into runs"
        />
      </div>

      {!projectActive ? (
        <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-muted-foreground">
          Activate a project to author its Constitution.
        </div>
      ) : (
        <>
          <div className="mb-3 mt-3 flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-black/20 p-0.5">
              {MODE_TABS.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setMode(v)}
                  className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
                    v === mode
                      ? 'bg-primary/[0.18] text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {dirty && (
              <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-warning">
                Unsaved
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={regenerate}
                disabled={busy}
                aria-busy={busyAction === 'regenerate'}
              >
                {busyAction === 'regenerate' ? <Spinner /> : <RetryIcon size={14} />}
                {busyAction === 'regenerate' ? 'Regenerating…' : 'Regenerate'}
              </Button>
              <Button onClick={save} disabled={busy || !dirty} aria-busy={busyAction === 'save'}>
                {busyAction === 'save' ? <Spinner /> : null}
                {busyAction === 'save' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-[10px] border border-border bg-white/[0.02] px-3 py-6 text-[12.5px] text-muted-foreground">
              <Spinner />
              Loading…
            </div>
          ) : mode === 'edit' ? (
            <textarea
              value={content}
              onChange={(e) => onContentChange(e.target.value)}
              spellCheck={false}
              placeholder={EMPTY_PACK_PLACEHOLDER}
              className="h-[280px] w-full resize-y rounded-[10px] border border-border bg-white/[0.02] p-3 font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus:border-primary"
              aria-label="Context pack markdown"
            />
          ) : content.trim().length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-border px-4 py-8 text-center text-[12.5px] text-muted-foreground">
              {EMPTY_PACK_PLACEHOLDER}
            </div>
          ) : (
            <CodeBlock code={content} language={PACK_LANGUAGE} className="max-h-[320px]" />
          )}

          {error !== null && (
            <p className="mt-2 text-[11.5px] text-destructive">{error}</p>
          )}
        </>
      )}
    </section>
  );
}
