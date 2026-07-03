# tools/lint-meta

Frontend layer-boundary enforcement for `apps/web`, wired into the root
`eslint.config.mjs`. This is the `tools/lint-meta` port the base config's
comments deferred.

It exports a flat-config array (`layerRules`) of `no-restricted-imports` blocks
encoding the shiranami feature-folder boundaries:

1. **No cross-feature imports.** A file under `features/<A>/` may not import from
   `features/<B>/`. Shared code lives in `shared/`.
2. **Single Tauri seam.** Only the `lib/bridge/` module (types/commands/events/
   mocks + index barrel) may import `@tauri-apps/api`; every other module goes
   through the bridge.
3. **`shared/` purity.** `shared/**` may not import from `features/*` (primitives
   are leaves of the dependency graph) and stays Tauri-agnostic.

## Usage

```js
// eslint.config.mjs
import { layerRules } from './tools/lint-meta/index.mjs';

export default tseslint.config(
  // …existing config…
  ...layerRules,
);
```

## Verifying the rules fire

Add a cross-feature import temporarily, e.g. in
`apps/web/src/features/board/Board.tsx`:

```ts
import { ProjectCard } from '../projects';
```

`bun run lint` then reports:

> Features must not import each other. Lift shared code into shared/ …

Remove the import to restore green.

No runtime dependency — uses ESLint's built-in `no-restricted-imports` so it
works in the project's minimal flat config.
