import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './BoardBackgroundPanel.stories';

const { NoBackground, WithBackground } = composeStories(stories);

test('empty state shows the placeholder and a Choose Image button, no Clear', async () => {
  const screen = render(<NoBackground />);
  await expect.element(screen.getByText('No custom background')).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Choose Image' })).toBeInTheDocument();
  // No Clear button when there is no background.
  expect(screen.getByRole('button', { name: 'Clear' }).query()).toBeNull();
});

test('with a background: renders the preview image, Change Image, and Clear', async () => {
  const screen = render(<WithBackground />);
  await expect
    .element(screen.getByRole('img', { name: 'Current board background' }))
    .toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Change Image' })).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
});

test('opacity sliders reflect the persisted values as percentages', async () => {
  const screen = render(<WithBackground />);
  // 0.5 → "50%", 0.82 → "82%" (matches the reference panel).
  await expect.element(screen.getByText('82%')).toBeInTheDocument();
  const cardSlider = screen.getByRole('slider', { name: 'Card Opacity' });
  await expect.element(cardSlider).toHaveValue('50');
});

test('toggling a checkbox persists the flipped appearance', async () => {
  const onChangeAppearance = vi.fn();
  const screen = render(<WithBackground onChangeAppearance={onChangeAppearance} />);
  // The checkbox <input> is visually hidden (sr-only); click the visible label text,
  // which toggles the associated control natively.
  await screen.getByText('Card Glassmorphism (blur effect)').click();
  expect(onChangeAppearance).toHaveBeenCalledTimes(1);
  // The full next appearance is sent (whole-object replace) with the flipped knob
  // (the WithBackground story starts with glassmorphism on).
  expect(onChangeAppearance).toHaveBeenCalledWith(
    expect.objectContaining({ cardGlassmorphism: false }),
  );
});

test('Clear invokes the clear handler', async () => {
  const onClearImage = vi.fn();
  const screen = render(<WithBackground onClearImage={onClearImage} />);
  await screen.getByRole('button', { name: 'Clear' }).click();
  expect(onClearImage).toHaveBeenCalledTimes(1);
});
