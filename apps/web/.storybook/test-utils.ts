import { within } from 'storybook/test';

/** Modal overlays portal to `document.body` — query them here in story play tests. */
export function portaledSurface() {
  return within(document.body);
}
