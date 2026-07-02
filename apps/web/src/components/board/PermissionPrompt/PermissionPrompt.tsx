import { AlertIcon, Button, TerminalIcon } from '@/components/ui';

import { summarizeInput } from './PermissionPrompt.hooks';
import type { PermissionPromptProps } from './PermissionPrompt.types';

/** An interactive permission prompt: the tool the agent wants to run plus a
 *  one-line input summary, with Allow / Deny. Rendered in the detail panel while a
 *  run is parked awaiting approval. Presentational — the decision is relayed up. */
export function PermissionPrompt({ prompt, onRespond }: PermissionPromptProps) {
  return (
    <section className="rounded-lg border border-warning/45 bg-warning/[0.08] p-3">
      <div className="flex items-center gap-2">
        <AlertIcon size={14} className="shrink-0 text-warning" />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-warning">
          Approval needed
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 font-mono text-xs text-primary/90">
        <TerminalIcon size={12} />
        {prompt.toolName}
      </div>
      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/20 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90">
        {summarizeInput(prompt.input)}
      </pre>
      <div className="mt-2.5 flex items-center gap-2">
        <Button onClick={() => onRespond(prompt.requestId, 'allow')}>Allow</Button>
        <Button variant="danger" onClick={() => onRespond(prompt.requestId, 'deny')}>
          Deny
        </Button>
      </div>
    </section>
  );
}
