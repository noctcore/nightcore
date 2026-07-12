import { AlertIcon, Button, Kbd, Spinner, TerminalIcon } from '@/components/ui';

import { summarizeInput, usePermissionDecision } from './PermissionPromptCard.hooks';
import type { PermissionPromptCardProps } from './PermissionPromptCard.types';

/** An interactive permission prompt: the tool the agent wants to run plus a
 *  one-line input summary, with Allow / Deny. Rendered in the interaction dock
 *  while a run is parked awaiting approval. Presentational — the decision is
 *  relayed up.
 *
 *  Mirrors the QuestionPromptCard sibling's convention: a native `<form>` whose
 *  primary action (Allow) is the submit, so Enter-on-Allow and a form-level
 *  Cmd/Ctrl+Enter both approve, and the shortcut is announced with a `<Kbd>`
 *  hint. The first decision latches (see {@link usePermissionDecision}), so both
 *  buttons then disable + report `aria-busy` — no double-fire on a consequential,
 *  security-relevant control, and an accessible in-flight signal. */
export function PermissionPromptCard({ prompt, onRespond }: PermissionPromptCardProps) {
  const { deciding, respond } = usePermissionDecision(prompt.requestId, onRespond);
  const pending = deciding !== null;

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- form-level Cmd/Ctrl+Enter shortcut; native submit (Allow / Enter-on-Allow) is the primary path
    <form
      className="rounded-lg border border-warning/45 bg-warning/[0.08] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        respond('allow');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          respond('allow');
        }
      }}
    >
      <div className="flex items-center gap-2">
        <AlertIcon size={14} className="shrink-0 text-warning" />
        <span className="font-mono text-2xs font-semibold uppercase tracking-[0.08em] text-warning">
          Approval needed
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 font-mono text-xs text-primary/90">
        <TerminalIcon size={12} />
        {prompt.toolName}
      </div>
      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 px-2.5 py-1.5 font-mono text-2xs text-foreground/90">
        {summarizeInput(prompt.input)}
      </pre>
      <div className="mt-2.5 flex items-center gap-2">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {deciding === 'allow' ? <Spinner /> : null}
          Allow <Kbd>⌘↵</Kbd>
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={pending}
          aria-busy={pending}
          onClick={() => respond('deny')}
        >
          {deciding === 'deny' ? <Spinner /> : null}
          Deny
        </Button>
      </div>
    </form>
  );
}
