/** The Council start form: pick a preset (P1 ships one — `research`), enter the
 *  objective, and convene. Submit mirrors the board's composer convention
 *  (Cmd/Ctrl+Enter sends, blank objective disables Start). */
import { AgentsIcon, Button, Card, Kbd } from '@/components/ui';

import { useCouncilStartPanel } from './CouncilStartPanel.hooks';
import type { CouncilStartPanelProps } from './CouncilStartPanel.types';

const OBJECTIVE_INPUT_ID = 'council-objective';

export function CouncilStartPanel({ onStart, disabled = false }: CouncilStartPanelProps) {
  const { objective, setObjective, canStart } = useCouncilStartPanel();
  const ready = canStart && !disabled;

  const submit = () => {
    if (!ready) return;
    onStart(objective);
  };

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

      {/* Preset picker — one option in P1. Rendered as a selected card so the surface
          is future-proof for more presets without a layout change. */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
          Preset
        </legend>
        <Card selected className="flex items-start gap-3 bg-primary/[0.04] p-3">
          <span className="mt-0.5 flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <AgentsIcon size={14} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm-flat font-medium text-foreground">Research</p>
            <p className="text-xs-plus text-muted-foreground">
              ≤4 seats, ≥2 distinct models · Frame → Propose (blind) → Debate → Converge
              (you judge). Hard budget + round caps; a kill switch is always live.
            </p>
          </div>
        </Card>
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
          disabled={disabled}
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="What should the council debate? e.g. “Compare two migration strategies for the worktree store.”"
          className="w-full resize-none rounded-[10px] border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary disabled:opacity-50"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready}>
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
