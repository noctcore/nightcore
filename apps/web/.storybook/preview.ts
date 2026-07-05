import '../src/styles.css';

import type { Preview } from '@storybook/react-vite';
import React from 'react';

import { MotionProvider } from '../src/components/ui/motion';
import { nightcoreTheme } from './nightcore-theme';

/**
 * Provide the motion/react runtime (LazyMotion + reduced-motion config) to every
 * story, mirroring App.tsx, so components that render `m.*` / `AnimatePresence`
 * have their feature bundle and animate in Storybook exactly as they do in the app.
 * Under the Vitest gate these animations are made instant via
 * `MotionGlobalConfig.skipAnimations` (see .storybook/vitest.setup.ts); this
 * decorator only supplies the provider.
 */
const withMotion = (Story: React.ComponentType) =>
  React.createElement(MotionProvider, null, React.createElement(Story));

/**
 * Wrap every story in the cosmic-dark surface. The tokens live on :root in
 * styles.css, but scoping the theme class + background on a decorator container
 * (rather than the preview <body>) prevents theme-bleed into Storybook's own
 * chrome and keeps each story rendered on the real app background.
 */
const withTheme = (Story: React.ComponentType) =>
  React.createElement(
    'div',
    {
      className: 'cosmic dark',
      style: {
        background: 'var(--nc-background)',
        color: 'var(--nc-foreground)',
        fontFamily: 'var(--font-sans)',
        minHeight: '100%',
        padding: '24px',
      },
    },
    React.createElement(Story),
  );

const preview: Preview = {
  decorators: [withMotion, withTheme],
  parameters: {
    backgrounds: { disable: true },
    // Brand the Docs pages with the same cosmic-dark theme as the manager
    // chrome (see manager.ts) so autodocs match the app surface.
    docs: { theme: nightcoreTheme },
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    a11y: {
      // Surface a11y findings in the panel; do not fail the build on them so
      // the pilot stories stay green while the surface set grows.
      test: 'todo',
    },
  },
};

export default preview;
