import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import { activeModelId } from './ModelEffortPicker.hooks';
import * as stories from './ModelEffortPicker.stories';

const { Inherit, OpusHigh, LegacyModelId, Disabled } = composeStories(stories);

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

test('activeModelId resolves canonical, legacy, and unknown ids', () => {
  expect(activeModelId(null)).toBeNull();
  expect(activeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  expect(activeModelId('sonnet-4.6')).toBe('claude-sonnet-4-6');
  expect(activeModelId('haiku-4.5')).toBe('claude-haiku-4-5-20251001');
  expect(activeModelId('gpt-9')).toBeNull();
});
