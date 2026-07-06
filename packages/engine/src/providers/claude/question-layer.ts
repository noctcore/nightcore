import type {
  OnUserDialog,
  UserDialogRequest,
  UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { QuestionAnswer, QuestionItem } from '@nightcore/contracts';
import { QuestionItemSchema } from '@nightcore/contracts';
import { createRequestIdFactory, type Logger } from '@nightcore/shared';

/**
 * The SDK dialog kind the Claude CLI uses to collect `AskUserQuestion` answers.
 * Verified against the bundled CLI: the tool surfaces NOT through `canUseTool`
 * but as a `request_user_dialog` of this kind, whose payload carries the
 * `questions` and whose result is a `PermissionResult`-shaped object. The runner
 * declares ONLY this kind in `supportedDialogKinds`, so other dialog kinds
 * (e.g. `permission_bash`) keep their existing `canUseTool` no-dialog behavior.
 */
export const ASK_USER_QUESTION_DIALOG = 'permission_ask_user_question';

/**
 * The tool NAME the model uses for an AskUserQuestion call. The PermissionLayer
 * auto-allows it so `canUseTool` never surfaces it as a generic allow/deny prompt
 * (it carries no side effect — the real interaction is the dialog above).
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

const QuestionsPayloadSchema = z.array(QuestionItemSchema);

/**
 * A parked AskUserQuestion dialog. The QuestionLayer hands the prompt out to the
 * surface (via `onPrompt`) and stores a resolver keyed by requestId; the
 * SessionRunner resolves it when an `answer-question` command arrives.
 */
interface PendingQuestion {
  resolve: (result: UserDialogResult) => void;
  /** Parsed questions, used to map a chosen label back to its option preview. */
  questions: QuestionItem[];
  /** The original tool input slot (`{ questions }`), echoed back under
   *  `updatedInput` so the SDK's AskUserQuestion result is built from the exact
   *  input the model sent, plus the user's `answers`. */
  rawInput: Record<string, unknown>;
}

export interface QuestionPromptRequest {
  requestId: string;
  /** SDK toolUseId of the originating call, when the dialog carries one. */
  toolUseId?: string;
  questions: QuestionItem[];
}

/**
 * Implements the SDK's `onUserDialog` callback for the `AskUserQuestion` dialog.
 * Parallel to `PermissionLayer` (which owns `canUseTool`) but for an interactive
 * Q&A rather than a tool allow/deny: it parks the dialog, emits a
 * `question-required` event to the surface, and settles the dialog when the
 * surface answers — mapping the answer onto the `PermissionResult`-shaped result
 * the CLI consumes (`{ behavior: 'allow', updatedInput: { ...input, answers } }`).
 *
 * Cancel paths mirror the PermissionLayer: an unrecognized dialog kind, a
 * malformed payload, a query abort, or session teardown all settle as
 * `{ behavior: 'cancelled' }` so the SDK applies the dialog's default (the model
 * proceeds without an answer) and no control request is left dangling.
 */
export class QuestionLayer {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly nextRequestId = createRequestIdFactory('q');

  constructor(
    private readonly onPrompt: (req: QuestionPromptRequest) => void,
    private readonly logger?: Logger,
  ) {}

  /** The callback wired into the SDK `query()` options as `onUserDialog`. */
  readonly onUserDialog: OnUserDialog = (request, options) => {
    if (request.dialogKind !== ASK_USER_QUESTION_DIALOG) {
      // The SDK REQUIRES `cancelled` for a kind this consumer doesn't render —
      // any other reply could settle a dialog another attached client owns.
      return Promise.resolve<UserDialogResult>({ behavior: 'cancelled' });
    }
    return this.prompt(request, options);
  };

  /** Park an AskUserQuestion dialog and hand the prompt to the surface. */
  private prompt(
    request: UserDialogRequest,
    options: { signal: AbortSignal },
  ): Promise<UserDialogResult> {
    const parsed = QuestionsPayloadSchema.safeParse(request.payload.questions);
    if (!parsed.success || parsed.data.length === 0) {
      // Malformed/empty payload — cancel rather than park a prompt the surface
      // can't render (degrade, don't throw).
      this.logger?.warn('ask-user-question dialog had no parseable questions; cancelling');
      return Promise.resolve<UserDialogResult>({ behavior: 'cancelled' });
    }
    const questions = parsed.data;
    const requestId = this.nextRequestId();
    this.logger?.debug('awaiting interactive answer', {
      requestId,
      questionCount: questions.length,
    });

    return new Promise<UserDialogResult>((resolve) => {
      this.pending.set(requestId, {
        resolve,
        questions,
        rawInput: { questions: request.payload.questions },
      });

      // If the SDK aborts the query while we're parked, settle as cancelled so
      // the promise never dangles (mirrors the PermissionLayer abort path).
      options.signal.addEventListener(
        'abort',
        () => this.settleCancelled(requestId),
        { once: true },
      );

      this.onPrompt({ requestId, toolUseId: request.toolUseID, questions });
    });
  }

  /** Resolve a parked question from a surface `answer-question` command.
   *  Returns false if the requestId is unknown (already settled / stale). */
  resolve(requestId: string, answer: QuestionAnswer): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(toDialogResult(entry.rawInput, entry.questions, answer));
    return true;
  }

  /** Cancel every pending question — used on session teardown so no SDK dialog
   *  control request is left hanging. */
  failAllPending(): void {
    for (const [requestId, entry] of this.pending) {
      entry.resolve({ behavior: 'cancelled' });
      this.logger?.debug('cancelled pending question on teardown', { requestId });
    }
    this.pending.clear();
  }

  private settleCancelled(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    entry.resolve({ behavior: 'cancelled' });
  }
}

/**
 * Map a surface answer onto the CLI's dialog result. An `answer` becomes the
 * `PermissionResult`-shaped allow the AskUserQuestion tool consumes — the
 * original input echoed back with the user's `answers` (and per-question
 * `annotations` carrying the chosen option's preview, when it had one, matching
 * what the CLI's own picker emits). A `cancel` settles as `cancelled` so the SDK
 * applies the dialog default.
 */
function toDialogResult(
  rawInput: Record<string, unknown>,
  questions: QuestionItem[],
  answer: QuestionAnswer,
): UserDialogResult {
  if (answer.behavior === 'cancel') {
    return { behavior: 'cancelled' };
  }
  const annotations = buildAnnotations(questions, answer.answers);
  const updatedInput: Record<string, unknown> = {
    ...rawInput,
    answers: answer.answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
  return {
    behavior: 'completed',
    result: { behavior: 'allow', updatedInput },
  };
}

/** Build the per-question `annotations` the CLI attaches when a chosen option
 *  carries a `preview` — keyed by question prompt text, matching the CLI's own
 *  answer builder. Free-text answers (no matching option label) contribute no
 *  annotation; the answer itself already lives in `answers`. */
function buildAnnotations(
  questions: QuestionItem[],
  answers: Record<string, string>,
): Record<string, { preview: string }> {
  const annotations: Record<string, { preview: string }> = {};
  for (const q of questions) {
    const chosen = answers[q.question];
    if (chosen === undefined) continue;
    const option = q.options.find((o) => o.label === chosen);
    if (option?.preview !== undefined) {
      annotations[q.question] = { preview: option.preview };
    }
  }
  return annotations;
}
