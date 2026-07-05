import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { DURATION, EASE, MotionProvider } from './index';

test('exposes the canonical duration + easing tokens', () => {
  // These are mirrored into styles.css :root; the mirror comment there points back.
  expect(DURATION.base).toBe(0.22);
  expect(DURATION.fast).toBe(0.14);
  expect(DURATION.slow).toBe(0.32);
  expect(EASE.outQuint).toEqual([0.22, 1, 0.36, 1]);
  expect(EASE.standard).toEqual([0.4, 0, 0.2, 1]);
});

test('MotionProvider renders its children (LazyMotion + MotionConfig wrapper)', async () => {
  const screen = render(
    <MotionProvider>
      <p>motion child</p>
    </MotionProvider>,
  );
  await expect.element(screen.getByText('motion child')).toBeVisible();
});
