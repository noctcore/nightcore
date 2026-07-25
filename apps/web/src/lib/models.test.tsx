import { expect, test } from 'vitest';

import {
  codexStaticModelDescriptors,
  effortOptionsForModel,
  isAdaptiveModel,
  isEffortSupported,
  MODEL_OPTIONS,
  modelLabel,
  modelOptionFor,
} from './models';

test('MODEL_OPTIONS carry tier + effort metadata for every surfaced model', () => {
  expect(MODEL_OPTIONS.map((m) => m.id)).toEqual([
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ]);
  const opus = MODEL_OPTIONS.find((m) => m.id === 'claude-opus-4-8');
  expect(opus?.tier).toBe('Premium');
  expect(opus?.adaptive).toBe(true);
});

test('modelOptionFor resolves canonical, legacy, inherit, and unknown ids', () => {
  expect(modelOptionFor(null)).toBeNull();
  expect(modelOptionFor('claude-opus-4-8')?.id).toBe('claude-opus-4-8');
  expect(modelOptionFor('gpt-5-codex')?.id).toBe('gpt-5-codex');
  expect(modelOptionFor('sonnet-4.6')?.id).toBe('claude-sonnet-4-6');
  expect(modelOptionFor('haiku-4.5')?.id).toBe('claude-haiku-4-5');
  expect(modelOptionFor('gpt-9')).toBeNull();
});

test('codexStaticModelDescriptors exposes the SDK-backed Codex default', () => {
  expect(codexStaticModelDescriptors()).toEqual([
    expect.objectContaining({
      providerId: 'codex',
      value: 'gpt-5-codex',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    }),
  ]);
});

test('effortOptionsForModel unlocks xhigh/max only for the premium model', () => {
  const opus = effortOptionsForModel('claude-opus-4-8').map((o) => o.id);
  expect(opus).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'none']);

  const haiku = effortOptionsForModel('claude-haiku-4-5').map((o) => o.id);
  expect(haiku).toEqual(['low', 'medium', 'high', 'none']);

  const codex = effortOptionsForModel('gpt-5-codex').map((o) => o.id);
  expect(codex).toEqual(['low', 'medium', 'high', 'xhigh', 'none']);
});

test('effortOptionsForModel falls back to the base set for Inherit / unknown', () => {
  expect(effortOptionsForModel(null).map((o) => o.id)).toEqual(['low', 'medium', 'high', 'none']);
  expect(effortOptionsForModel('gpt-9').map((o) => o.id)).toEqual(['low', 'medium', 'high', 'none']);
});

test('every effort option carries a description', () => {
  for (const option of effortOptionsForModel('claude-opus-4-8')) {
    expect(option.description.length).toBeGreaterThan(0);
  }
});

test('isAdaptiveModel is true only for the adaptive models', () => {
  expect(isAdaptiveModel('claude-opus-4-8')).toBe(true);
  expect(isAdaptiveModel('claude-sonnet-4-6')).toBe(false);
  expect(isAdaptiveModel('claude-haiku-4-5')).toBe(false);
  expect(isAdaptiveModel(null)).toBe(false);
});

test('isEffortSupported treats Inherit and none as always valid', () => {
  expect(isEffortSupported('claude-haiku-4-5', null)).toBe(true);
  expect(isEffortSupported('claude-haiku-4-5', 'none')).toBe(true);
});

test('isEffortSupported rejects a premium-only effort once the model changes', () => {
  expect(isEffortSupported('claude-opus-4-8', 'max')).toBe(true);
  // 'max' is not offered by Haiku — switching models must reconcile it.
  expect(isEffortSupported('claude-haiku-4-5', 'max')).toBe(false);
  expect(isEffortSupported('claude-haiku-4-5', 'high')).toBe(true);
});

test('modelLabel resolves Inherit, known, Codex, and unknown ids', () => {
  expect(modelLabel(null)).toBe('the inherited model');
  expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8');
  expect(modelLabel('gpt-5-codex')).toBe('GPT-5 Codex');
  expect(modelLabel('some-unknown-model')).toBe('some-unknown-model');
});
