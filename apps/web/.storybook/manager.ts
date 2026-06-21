import { addons } from 'storybook/manager-api';
import { nightcoreTheme } from './nightcore-theme';

// Brand the Storybook manager UI (sidebar, toolbar, logo) to match Nightcore's
// cosmic-dark palette.
addons.setConfig({ theme: nightcoreTheme });
