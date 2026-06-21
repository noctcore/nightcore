import { beforeAll } from 'vitest';
import { setProjectAnnotations } from '@storybook/react-vite';
import * as previewAnnotations from './preview';

// Apply the preview-level annotations (decorators, parameters) to every story
// when they run as Vitest tests via the Storybook plugin. Required by the
// portable-stories API the addon-vitest uses internally.
const project = setProjectAnnotations([previewAnnotations]);

beforeAll(project.beforeAll);
