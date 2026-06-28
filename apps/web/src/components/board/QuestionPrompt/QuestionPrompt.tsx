/** Interactive AskUserQuestion prompt shown in the interaction dock. */
import { Button, CheckIcon, Kbd, QuestionIcon } from '@/components/ui';
import { useQuestionAnswers } from './QuestionPrompt.hooks';
import type { QuestionPromptProps } from './QuestionPrompt.types';

/**
 * An interactive `AskUserQuestion` prompt: the model's question(s), each with
 * selectable options AND a free-text "type your own" answer, plus Send / Skip.
 * Rendered in the interaction dock while a run is parked awaiting an answer.
 * Presentational — the per-question answer state lives in `useQuestionAnswers`;
 * the chosen answers are relayed up via `onAnswer`.
 *
 * Submit is a native `<form>` submit (Send is `type="submit"`, so Enter-in-input
 * and the button both submit and the shortcut is announced); a form-level keydown
 * adds Cmd/Ctrl+Enter from anywhere in the prompt (e.g. an option has focus),
 * matching the board's modal convention. `submit()` is a no-op until every
 * question is answered, so an early Enter can't send a partial answer.
 */
export function QuestionPrompt({ prompt, onAnswer }: QuestionPromptProps) {
  const answers = useQuestionAnswers(prompt);

  const submit = () => {
    if (!answers.allAnswered) return;
    onAnswer(prompt.requestId, answers.buildAnswer());
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- form-level Cmd/Ctrl+Enter shortcut; native submit (Send / Enter-in-input) is the primary path
    <form
      className="rounded-lg border border-info/45 bg-info/[0.08] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <QuestionIcon size={14} className="shrink-0 text-info" aria-hidden />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-info">
          Claude asked
        </span>
      </div>

      <div className="mt-2.5 space-y-3.5">
        {prompt.questions.map((q, qi) => {
          const inputId = `q-${prompt.requestId}-${qi}`;
          return (
            <div key={inputId} role="group" aria-label={q.question} className="space-y-2">
              <div>
                <span className="inline-block rounded border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {q.header}
                </span>
                <p className="mt-1.5 text-sm leading-snug text-foreground/90">{q.question}</p>
              </div>

              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const selected = answers.isSelected(q, opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => answers.toggleOption(q, opt.label)}
                      className={`block w-full rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                        selected
                          ? 'border-primary bg-primary/[0.12]'
                          : 'border-border bg-white/[0.02] hover:bg-white/[0.05]'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {/* Non-color affordance for the selected state (the color
                            change alone wouldn't satisfy WCAG 1.4.1). */}
                        <CheckIcon
                          size={12}
                          aria-hidden
                          className={`shrink-0 text-primary ${selected ? '' : 'invisible'}`}
                        />
                        <span
                          className={`text-xs ${
                            selected ? 'font-bold text-foreground' : 'font-semibold text-foreground/90'
                          }`}
                        >
                          {opt.label}
                        </span>
                      </span>
                      {opt.description.length > 0 && (
                        <span className="mt-0.5 block pl-[18px] text-[11px] leading-snug text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div>
                <label
                  htmlFor={inputId}
                  className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                >
                  Or type your own answer
                </label>
                <input
                  id={inputId}
                  type="text"
                  value={answers.typedFor(q)}
                  onChange={(e) => answers.setTyped(q, e.target.value)}
                  placeholder="Custom answer…"
                  className="w-full rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-sm text-foreground/90 placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="submit"
          disabled={!answers.allAnswered}
          title={answers.allAnswered ? undefined : 'Answer every question to send'}
        >
          Send answer <Kbd>⌘↵</Kbd>
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onAnswer(prompt.requestId, { behavior: 'cancel' })}
        >
          Skip
        </Button>
      </div>
    </form>
  );
}
