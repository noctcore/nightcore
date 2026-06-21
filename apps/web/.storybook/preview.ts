import type { Preview } from '@storybook/react-vite';
import React from 'react';
import { nightcoreTheme } from './nightcore-theme';
import '../src/styles.css';

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
  decorators: [withTheme],
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
