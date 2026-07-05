import { setProjectAnnotations } from '@storybook/react-vite';
import { MotionGlobalConfig } from 'motion/react';
import { beforeAll } from 'vitest';

import * as previewAnnotations from './preview';

// Make every motion/react animation resolve instantly under the Vitest gate, so
// story play-tests and unit tests never race an in-flight enter/exit (a `.click()`
// landing on a still-sliding element is a latent flake — the JS-motion analogue of
// the browser's `prefers-reduced-motion: reduce` context, which only governs CSS
// animation). Storybook dev is unaffected — this file runs only under Vitest.
MotionGlobalConfig.skipAnimations = true;

// Apply the preview-level annotations (decorators, parameters) to every story
// when they run as Vitest tests via the Storybook plugin. Required by the
// portable-stories API the addon-vitest uses internally.
const project = setProjectAnnotations([previewAnnotations]);

beforeAll(project.beforeAll);
