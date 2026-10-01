/** The ModelEffortPicker is a deprecated thin adapter over `ModelSelectField`
 *  (B5) — its own combobox behavior is covered by `ModelSelect` / `ModelSelectField`
 *  tests, so this only pins the adapter's job: translating the old
 *  model/effort two-callback API onto the single `ModelSelection` onChange. */
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ModelEffortPicker } from './ModelEffortPicker';
import { activeModelId } from './ModelEffortPicker.hooks';

test('renders the live combobox + effort row (delegates to ModelSelectField)', async () => {
  const screen = render(
    <ModelEffortPicker model={null} effort={null} onChangeModel={vi.fn()} onChangeEffort={vi.fn()} />,
  );
  await expect.element(screen.getByRole('combobox', { name: /model/i })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('radiogroup', { name: /reasoning effort/i }))
    .toBeInTheDocument();
});

test('delegates a model pick to onChangeModel with the canonical id', async () => {
  const onChangeModel = vi.fn();
  const onChangeEffort = vi.fn();
  const screen = render(
    <ModelEffortPicker
      model={null}
      effort={null}
      onChangeModel={onChangeModel}
      onChangeEffort={onChangeEffort}
    />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /sonnet/i }).click();
  expect(onChangeModel).toHaveBeenCalledWith('claude-sonnet-5');
  // The effort stayed Inherit, so the adapter fires only the changed callback.
  expect(onChangeEffort).not.toHaveBeenCalled();
});

test('switching to a model that cannot honor the pinned effort resets it to Inherit', async () => {
  const onChangeModel = vi.fn();
  const onChangeEffort = vi.fn();
  const screen = render(
    <ModelEffortPicker
      model="claude-opus-5-5"
      effort="max"
      onChangeModel={onChangeModel}
      onChangeEffort={onChangeEffort}
    />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /haiku/i }).click();
  expect(onChangeModel).toHaveBeenCalledWith('claude-haiku-4-5');
  expect(onChangeEffort).toHaveBeenCalledWith(null);
});

test('activeModelId resolves canonical, legacy, and unknown ids', () => {
  expect(activeModelId(null)).toBeNull();
  expect(activeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  expect(activeModelId('sonnet-4.6')).toBe('claude-sonnet-5');
  expect(activeModelId('haiku-4.5')).toBe('claude-haiku-4-5');
  expect(activeModelId('gpt-9')).toBeNull();
});
