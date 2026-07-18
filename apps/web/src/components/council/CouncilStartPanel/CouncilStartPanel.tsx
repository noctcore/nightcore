/** The Council start form: pick a preset, enter the objective, and convene. Submit
 *  mirrors the board's composer convention (Cmd/Ctrl+Enter sends, blank objective
 *  disables Start). A failed convene keeps the typed draft and surfaces the reason
 *  inline (GOV-5); the chosen preset id is passed through to `start_council` (GOV-2). */
import { AgentsIcon, Button, Kbd } from '@/components/ui';

import { COUNCIL_PRESET_CARDS } from '../council-presets';
import { useCouncilStartPanel } from './CouncilStartPanel.hooks';
import type { CouncilStartPanelProps } from './CouncilStartPanel.types';

const OBJECTIVE_INPUT_ID = 'council-objective';

export function CouncilStartPanel({ onStart, disabled = false }: CouncilStartPanelProps) {
  const { objective, setObjective, presetId, selectPreset, canStart, starting, startError, submit } =
    useCouncilStartPanel(onStart, disabled);
  const ready = canStart && !disabled;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-10">
      <header className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <AgentsIcon size={18} aria-hidden />
        </span>
        <div>
          <h2 className="text-sm-flat font-semibold text-foreground">Convene a council</h2>
          <p className="text-xs-plus text-muted-foreground">
            Heterogeneous seats debate under a conductor — governed reasoning, not more
            agents. Use it when disagreement is the point, not for a knowable answer.
          </p>
        </div>
      </header>

      {/* Preset picker — one selectable card per preset (GOV-2). */}
      <fieldset className="flex flex-col gap-2" disabled={disabled || starting}>
        <legend className="mb-1 font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
          Preset
        </legend>
        <div className="grid gap-2">
          {COUNCIL_PRESET_CARDS.map((card) => {
            const selected = presetId === card.id;
            return (
              <label
                key={card.id}
                className={`flex cursor-pointer items-start gap-3 rounded-nc border px-3 py-2.5 transition-colors ${
                  selected
                    ? 'border-primary bg-primary/[0.06]'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <input
                  type="radio"
                  name="council-preset"
                  value={card.id}
                  checked={selected}
                  onChange={() => selectPreset(card.id)}
                  className="mt-1 accent-primary"
                />
                <span className="min-w-0 text-sm-flat font-medium text-foreground">
                  {card.title}
                  <span className="mt-0.5 block text-xs-plus font-normal text-muted-foreground">
                    {card.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <form
        aria-label="Convene a council"
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label
          htmlFor={OBJECTIVE_INPUT_ID}
          className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground"
        >
          Objective
        </label>
        <textarea
          id={OBJECTIVE_INPUT_ID}
          value={objective}
          disabled={disabled || starting}
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="What should the council debate? e.g. “Compare two migration strategies for the worktree store.”"
          className="w-full resize-none rounded-nc border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary disabled:opacity-50"
        />
        {startError !== null && (
          <p
            role="alert"
            className="rounded-nc border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-xs-plus text-destructive"
          >
            {startError}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready} busy={starting}>
            Convene council <Kbd>⌘↵</Kbd>
          </Button>
          {disabled && (
            <span className="text-xs-plus text-muted-foreground">
              Open a project to convene a council.
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
