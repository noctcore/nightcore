import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ModelEffortPicker } from './ModelEffortPicker';
import { activeModelId } from './ModelEffortPicker.hooks';
import * as stories from './ModelEffortPicker.stories';

const { Inherit, OpusHigh, OpusUnlocksMax, HaikuBaseEfforts, LegacyModelId, Disabled } =
  composeStories(stories);

test('marks Inherit checked for both rows when null', async () => {
  const screen = render(<Inherit />);
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await expect
    .element(modelGroup.getByRole('radio', { name: /inherit/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('marks the selected model + effort checked', async () => {
  const screen = render(<OpusHigh />);
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await expect
    .element(modelGroup.getByRole('radio', { name: /opus/i }))
    .toHaveAttribute('aria-checked', 'true');
  const effortGroup = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  await expect
    .element(effortGroup.getByRole('radio', { name: /^high$/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('highlights the right chip for a legacy short model id', async () => {
  const screen = render(<LegacyModelId />);
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await expect
    .element(modelGroup.getByRole('radio', { name: /sonnet/i }))
    .toHaveAttribute('aria-checked', 'true');
});

test('fires onChangeModel with the canonical id', async () => {
  const onChangeModel = vi.fn();
  const screen = render(<Inherit onChangeModel={onChangeModel} />);
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await modelGroup.getByRole('radio', { name: /opus/i }).click();
  expect(onChangeModel).toHaveBeenCalledWith('claude-opus-4-8');
});

test('disables every option when disabled', async () => {
  const screen = render(<Disabled />);
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await expect.element(modelGroup.getByRole('radio', { name: /inherit/i })).toBeDisabled();
});

test('the premium model unlocks the Max effort level + shows the adaptive hint', async () => {
  const screen = render(<OpusUnlocksMax />);
  const effortGroup = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  await expect
    .element(effortGroup.getByRole('radio', { name: /^max$/i }))
    .toHaveAttribute('aria-checked', 'true');
  await expect.element(screen.getByText(/decides adaptively/i)).toBeInTheDocument();
});

test('the speed model does not offer the Max effort level', async () => {
  const screen = render(<HaikuBaseEfforts />);
  const effortGroup = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  // `.query()` returns null when no element matches (vitest-browser locators).
  expect(effortGroup.getByRole('radio', { name: /^max$/i }).query()).toBeNull();
});

test('switching to a model that cannot honor the pinned effort resets it to Inherit', async () => {
  const onChangeModel = vi.fn();
  const onChangeEffort = vi.fn();
  const screen = render(
    <ModelEffortPicker
      model="claude-opus-4-8"
      effort="max"
      onChangeModel={onChangeModel}
      onChangeEffort={onChangeEffort}
    />,
  );
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await modelGroup.getByRole('radio', { name: /haiku/i }).click();
  expect(onChangeModel).toHaveBeenCalledWith('claude-haiku-4-5');
  expect(onChangeEffort).toHaveBeenCalledWith(null);
});

test('switching between models that both support the effort leaves it untouched', async () => {
  const onChangeModel = vi.fn();
  const onChangeEffort = vi.fn();
  const screen = render(
    <ModelEffortPicker
      model="claude-opus-4-8"
      effort="high"
      onChangeModel={onChangeModel}
      onChangeEffort={onChangeEffort}
    />,
  );
  const modelGroup = screen.getByRole('radiogroup', { name: /model/i });
  await modelGroup.getByRole('radio', { name: /sonnet/i }).click();
  expect(onChangeModel).toHaveBeenCalledWith('claude-sonnet-4-6');
  expect(onChangeEffort).not.toHaveBeenCalled();
});

test('activeModelId resolves canonical, legacy, and unknown ids', () => {
  expect(activeModelId(null)).toBeNull();
  expect(activeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  expect(activeModelId('sonnet-4.6')).toBe('claude-sonnet-4-6');
  expect(activeModelId('haiku-4.5')).toBe('claude-haiku-4-5');
  expect(activeModelId('gpt-9')).toBeNull();
});
