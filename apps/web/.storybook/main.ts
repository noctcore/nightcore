import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: { disableTelemetry: true },
  viteFinal: async (viteConfig) => {
    // Storybook's interaction/test runtime benefits from pre-bundling these.
    // `react-dom/client` must be here for the same reason it is in the `unit`
    // project's optimizeDeps (vitest.config.ts): if Vite discovers it mid-run
    // under the addon-vitest gate, the "optimized dependencies changed" reload
    // kills the in-flight test page and the vitest server waits on that file
    // forever — a silent CI freeze (capped only by the ci.yml job timeout).
    viteConfig.optimizeDeps = {
      ...viteConfig.optimizeDeps,
      include: [
        ...(viteConfig.optimizeDeps?.include ?? []),
        'storybook/test',
        'storybook/actions',
        'react-dom/client',
      ],
    };
    return viteConfig;
  },
};

export default config;
