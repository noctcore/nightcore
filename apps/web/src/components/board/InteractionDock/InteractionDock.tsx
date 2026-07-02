import { Badge, BellIcon } from '@/components/ui';

import { PermissionPrompt } from '../PermissionPrompt';
import { QuestionPrompt } from '../QuestionPrompt';
import { interactionCount } from './InteractionDock.hooks';
import type { InteractionDockProps } from './InteractionDock.types';

/**
 * A pinned, bottom-anchored dock that auto-surfaces whatever the run is currently
 * blocked on — permission approvals and AskUserQuestion prompts — so the user
 * never has to scroll the activity log to find the action. Rendered as a `shrink-0`
 * sibling BELOW the detail panel's scrollable content, so it stays put while the
 * log streams. Renders nothing when there's nothing to act on.
 */
export function InteractionDock({
  taskId,
  permissionPrompts,
  questionPrompts,
  onRespondPermission,
  onAnswerQuestion,
}: InteractionDockProps) {
  const total = interactionCount(permissionPrompts, questionPrompts);
  if (total === 0) return null;

  return (
    <section
      aria-label="Needs your input"
      className="shrink-0 border-t border-border bg-card"
    >
      <header className="flex items-center gap-2 px-4 pb-2 pt-3">
        <BellIcon size={13} className="shrink-0 text-warning" />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
          Needs your input
        </span>
        {total > 1 && <Badge>{total}</Badge>}
      </header>

      <div className="max-h-[50vh] space-y-2 overflow-auto px-4 pb-4">
        {/* Questions first: they block the model's reasoning, not just a tool call. */}
        {questionPrompts.map((prompt) => (
          <QuestionPrompt
            key={prompt.requestId}
            prompt={prompt}
            onAnswer={(requestId, answer) => onAnswerQuestion(taskId, requestId, answer)}
          />
        ))}
        {permissionPrompts.map((prompt) => (
          <PermissionPrompt
            key={prompt.requestId}
            prompt={prompt}
            onRespond={(requestId, decision) =>
              onRespondPermission(taskId, requestId, decision)
            }
          />
        ))}
      </div>
    </section>
  );
}
