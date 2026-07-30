/** The policy pattern tester: type a path, a command, or a tool name and see the
 *  verdict the runtime gate would return for the CURRENT draft — including which
 *  rule fired. Every verdict is computed by the same matchers the engine
 *  enforces with (`PatternTester.utils`), so this card cannot certify a rule that
 *  does not actually hold. */
import { Badge, TextField } from '@/components/ui';

import { usePatternTester } from './PatternTester.hooks';
import type { PatternTesterProps } from './PatternTester.types';
import type { ProbeOutcome, ProbeVerdict } from './PatternTester.utils';

const PROBE_INPUT = 'py-1.5 font-mono text-xs-plus';

/** Badge tone + label per outcome. `ask` is deliberately not a denial: the call
 *  proceeds if the human approves it. */
const OUTCOME: Record<ProbeOutcome, { tone: 'destructive' | 'warning' | 'success'; label: string }> =
  {
    denied: { tone: 'destructive', label: 'Denied' },
    ask: { tone: 'warning', label: 'Asks first' },
    allowed: { tone: 'success', label: 'Allowed' },
  };

/** One verdict line: the outcome chip, the sentence, and the attribution (which
 *  tier and which entry decided it). */
function VerdictLine({
  id,
  channel,
  verdict,
}: {
  id: string;
  channel: string;
  verdict: ProbeVerdict;
}) {
  const outcome = OUTCOME[verdict.outcome];
  return (
    <div id={id} className="flex items-start gap-2">
      <span className="w-[52px] shrink-0 pt-0.5 text-2xs text-muted-foreground">{channel}</span>
      <Badge tone={outcome.tone}>{outcome.label}</Badge>
      <p className="min-w-0 flex-1 text-2xs leading-snug text-muted-foreground">
        {verdict.message}
        {verdict.tier !== null && (
          <>
            {' '}
            <span className="text-muted-foreground/80">
              via <span className="font-mono text-foreground">{verdict.tier}</span>
            </span>
            {verdict.pattern !== null && (
              <>
                {' → '}
                <span className="font-mono text-foreground">{verdict.pattern}</span>
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

/** One labelled probe input plus the verdict lines it drives. */
function Probe({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-2xs-plus font-semibold text-muted-foreground">
        {label}
      </label>
      <TextField
        id={id}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={`${id}-verdicts`}
        onChange={(e) => onChange(e.target.value)}
        className={PROBE_INPUT}
      />
      {value.trim().length === 0 ? (
        <p className="text-2xs italic text-muted-foreground/80">{hint}</p>
      ) : (
        <div id={`${id}-verdicts`} className="flex flex-col gap-1" role="status">
          {children}
        </div>
      )}
    </div>
  );
}

/** The pattern tester card. */
export function PatternTester(props: PatternTesterProps) {
  const view = usePatternTester(props);

  return (
    <section
      aria-label="Pattern tester"
      className="flex flex-col gap-3 rounded-nc border border-border bg-white/[0.015] p-4"
    >
      <div className="flex flex-col gap-1">
        <h4 className="text-2xs-plus2 font-semibold text-foreground">Test these rules</h4>
        <p className="text-2xs text-muted-foreground">
          Answers for the rules ABOVE, saved or not, using the exact matchers the runtime gate
          enforces with. Paths are repo-relative; targets outside the repo are blocked by workspace
          confinement regardless of this policy.
        </p>
      </div>

      <Probe
        id="probe-path"
        label="Repo-relative path"
        hint="e.g. migrations/001_init.sql — shows whether an agent could write it and read it."
        placeholder="migrations/001_init.sql"
        value={view.path}
        onChange={view.setPath}
      >
        <VerdictLine id="probe-path-write" channel="Write" verdict={view.writeVerdict} />
        <VerdictLine id="probe-path-read" channel="Read" verdict={view.readVerdict} />
      </Probe>

      <Probe
        id="probe-command"
        label="Bash command line"
        hint="e.g. git commit --no-verify -m wip — matched against your denied patterns."
        placeholder="git commit --no-verify -m wip"
        value={view.command}
        onChange={view.setCommand}
      >
        <VerdictLine id="probe-command-bash" channel="Bash" verdict={view.commandVerdict} />
      </Probe>

      <Probe
        id="probe-tool"
        label="Tool name"
        hint="e.g. WebSearch or mcp__acme__push — matched exactly, case-sensitively."
        placeholder="WebSearch"
        value={view.tool}
        onChange={view.setTool}
      >
        <VerdictLine id="probe-tool-call" channel="Call" verdict={view.toolVerdict} />
      </Probe>
    </section>
  );
}
