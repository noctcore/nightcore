/** Prop types for the QuestionPrompt component. */
import type { QuestionAnswer, QuestionPrompt as QuestionPromptData } from '@/lib/bridge';

/** Props for `QuestionPrompt`. */
export interface QuestionPromptProps {
  /** The parked AskUserQuestion prompt to render (1–4 questions). */
  prompt: QuestionPromptData;
  /** Answer the prompt: submit the chosen/typed answers, or `cancel` to skip. */
  onAnswer: (requestId: string, answer: QuestionAnswer) => void;
}
