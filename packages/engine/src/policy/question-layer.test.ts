/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type {
  UserDialogRequest,
  UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk';

import {
  ASK_USER_QUESTION_DIALOG,
  QuestionLayer,
  type QuestionPromptRequest,
} from './question-layer.js';

const QUESTIONS = [
  {
    question: 'Which auth method should we use?',
    header: 'Auth method',
    options: [
      { label: 'OAuth', description: 'Delegate to an IdP.', preview: 'await oauth()' },
      { label: 'JWT', description: 'Self-issued signed tokens.' },
    ],
    multiSelect: false,
  },
];

function makeLayer(): {
  layer: QuestionLayer;
  prompts: QuestionPromptRequest[];
} {
  const prompts: QuestionPromptRequest[] = [];
  const layer = new QuestionLayer((req) => prompts.push(req));
  return { layer, prompts };
}

/** Drive `onUserDialog` once. Emitted prompts land in the layer's onPrompt sink. */
function dialog(
  layer: QuestionLayer,
  payload: Record<string, unknown>,
  opts: { toolUseID?: string; dialogKind?: string } = {},
): { result: Promise<UserDialogResult>; controller: AbortController } {
  const controller = new AbortController();
  const request = {
    dialogKind: opts.dialogKind ?? ASK_USER_QUESTION_DIALOG,
    payload,
    ...(opts.toolUseID !== undefined ? { toolUseID: opts.toolUseID } : {}),
  } as UserDialogRequest;
  return {
    result: layer.onUserDialog(request, { signal: controller.signal }),
    controller,
  };
}

describe('QuestionLayer dialog gating', () => {
  test('an unrecognized dialog kind is cancelled without prompting', async () => {
    const { layer, prompts } = makeLayer();
    const { result } = dialog(layer, { questions: QUESTIONS }, { dialogKind: 'permission_bash' });
    expect(await result).toEqual({ behavior: 'cancelled' });
    expect(prompts).toHaveLength(0);
  });

  test('an empty questions payload is cancelled without prompting', async () => {
    const { layer, prompts } = makeLayer();
    expect(await dialog(layer, { questions: [] }).result).toEqual({ behavior: 'cancelled' });
    expect(await dialog(layer, {}).result).toEqual({ behavior: 'cancelled' });
    expect(prompts).toHaveLength(0);
  });

  test('a valid dialog emits a prompt carrying parsed questions and toolUseId', () => {
    const { layer, prompts } = makeLayer();
    void dialog(layer, { questions: QUESTIONS }, { toolUseID: 'tu_aq_1' });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.toolUseId).toBe('tu_aq_1');
    expect(prompts[0]?.questions[0]?.question).toBe('Which auth method should we use?');
    expect(prompts[0]?.questions[0]?.options).toHaveLength(2);
    // requestId is the surface↔engine correlation token.
    expect(prompts[0]?.requestId).toBeTruthy();
  });
});

describe('QuestionLayer interactive resolve', () => {
  test('answering folds answers into updatedInput with preview annotations', async () => {
    const { layer, prompts } = makeLayer();
    const { result } = dialog(layer, { questions: QUESTIONS });
    const requestId = prompts[0]?.requestId ?? '';

    expect(
      layer.resolve(requestId, {
        behavior: 'answer',
        answers: { 'Which auth method should we use?': 'OAuth' },
      }),
    ).toBe(true);

    const settled = await result;
    expect(settled.behavior).toBe('completed');
    if (settled.behavior !== 'completed') throw new Error('expected completed');
    expect(settled.result).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        // Original input echoed back so the SDK builds the tool result from it.
        questions: QUESTIONS,
        answers: { 'Which auth method should we use?': 'OAuth' },
        // Chosen option carried a preview → mirrored into annotations.
        annotations: { 'Which auth method should we use?': { preview: 'await oauth()' } },
      },
    });
  });

  test('a free-text answer (no matching option label) carries no annotation', async () => {
    const { layer, prompts } = makeLayer();
    const { result } = dialog(layer, { questions: QUESTIONS });
    const requestId = prompts[0]?.requestId ?? '';

    layer.resolve(requestId, {
      behavior: 'answer',
      answers: { 'Which auth method should we use?': 'GraphQL subscriptions' },
    });

    const settled = await result;
    if (settled.behavior !== 'completed') throw new Error('expected completed');
    const updatedInput = (settled.result as { updatedInput: Record<string, unknown> })
      .updatedInput;
    expect(updatedInput.answers).toEqual({
      'Which auth method should we use?': 'GraphQL subscriptions',
    });
    // No option matched, so no annotations object is attached.
    expect(updatedInput.annotations).toBeUndefined();
  });

  test('a cancel answer settles the dialog as cancelled', async () => {
    const { layer, prompts } = makeLayer();
    const { result } = dialog(layer, { questions: QUESTIONS });
    const requestId = prompts[0]?.requestId ?? '';

    expect(layer.resolve(requestId, { behavior: 'cancel' })).toBe(true);
    expect(await result).toEqual({ behavior: 'cancelled' });
  });

  test('resolve returns false for an unknown requestId', () => {
    const { layer } = makeLayer();
    expect(layer.resolve('q-nope', { behavior: 'cancel' })).toBe(false);
  });
});

describe('QuestionLayer teardown safety', () => {
  test('an aborted query settles a parked question as cancelled', async () => {
    const { layer, prompts } = makeLayer();
    const { result, controller } = dialog(layer, { questions: QUESTIONS });
    expect(prompts).toHaveLength(1);

    controller.abort();
    expect(await result).toEqual({ behavior: 'cancelled' });
  });

  test('failAllPending cancels every parked question, then they are stale', async () => {
    const { layer, prompts } = makeLayer();
    const { result } = dialog(layer, { questions: QUESTIONS });
    const requestId = prompts[0]?.requestId ?? '';

    layer.failAllPending();
    expect(await result).toEqual({ behavior: 'cancelled' });
    // The parked entry is gone — a late answer is a no-op.
    expect(layer.resolve(requestId, { behavior: 'cancel' })).toBe(false);
  });
});
