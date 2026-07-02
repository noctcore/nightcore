/** State and handlers backing the QuestionPrompt's option/free-text answering. */
import { useState } from 'react';

import type { QuestionAnswer, QuestionItem, QuestionPrompt } from '@/lib/bridge';

/** The per-question answer state + handlers for a `QuestionPrompt`. Answer model:
 *  a non-empty free-text entry wins over option selection; otherwise the selected
 *  option label(s) are the answer, joined with `, ` for a multiSelect question
 *  (the wire shape the engine folds into the SDK dialog reply). */
export interface QuestionAnswersController {
  isSelected: (q: QuestionItem, label: string) => boolean;
  typedFor: (q: QuestionItem) => string;
  toggleOption: (q: QuestionItem, label: string) => void;
  setTyped: (q: QuestionItem, value: string) => void;
  /** True once every question has an answer (a selection or typed text). */
  allAnswered: boolean;
  /** The `answer` command payload for the current state. */
  buildAnswer: () => QuestionAnswer;
}

/** Resolve a question's current answer string, or `undefined` when unanswered. */
function answerFor(
  q: QuestionItem,
  selections: Record<string, string[]>,
  freeText: Record<string, string>,
): string | undefined {
  const typed = freeText[q.question]?.trim();
  if (typed) return typed;
  const picked = selections[q.question] ?? [];
  return picked.length > 0 ? picked.join(', ') : undefined;
}

/** Manage the per-question answer state (option selections and free text) for a
 *  `QuestionPrompt`, returning the controller the prompt UI binds to. */
export function useQuestionAnswers(prompt: QuestionPrompt): QuestionAnswersController {
  // Both maps are keyed by the question's prompt text (the SDK's own answer key).
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const toggleOption = (q: QuestionItem, label: string) => {
    // Picking an option supersedes any free text for that question.
    setFreeText((prev) => ({ ...prev, [q.question]: '' }));
    setSelections((prev) => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) {
        const next = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label];
        return { ...prev, [q.question]: next };
      }
      return { ...prev, [q.question]: [label] };
    });
  };

  const setTyped = (q: QuestionItem, value: string) => {
    // Typing a custom answer supersedes any option selection for that question.
    setSelections((prev) => ({ ...prev, [q.question]: [] }));
    setFreeText((prev) => ({ ...prev, [q.question]: value }));
  };

  const allAnswered = prompt.questions.every(
    (q) => answerFor(q, selections, freeText) !== undefined,
  );

  const buildAnswer = (): QuestionAnswer => {
    const answers: Record<string, string> = {};
    for (const q of prompt.questions) {
      const a = answerFor(q, selections, freeText);
      if (a !== undefined) answers[q.question] = a;
    }
    return { behavior: 'answer', answers };
  };

  return {
    isSelected: (q, label) => (selections[q.question] ?? []).includes(label),
    typedFor: (q) => freeText[q.question] ?? '',
    toggleOption,
    setTyped,
    allAnswered,
    buildAnswer,
  };
}
