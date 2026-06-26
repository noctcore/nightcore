# no-deep-package-imports

Workspace packages must be consumed through their `@nightcore/<pkg>` barrel only — never via a deep subpath into package internals.

## Rationale

The documented layering spine (`contracts → storage/shared → skills → engine → surfaces`) only holds if packages present a single public surface. A deep import like `@nightcore/contracts/internal/thing` reaches past the barrel and couples consumers to internals, letting the dependency graph drift from the declared edges.

This is a custom AST rule rather than a `no-restricted-imports` pattern on purpose: flat-config `no-restricted-imports` does not merge across blocks (the last matching block wins), so adding another restricted-imports block risks silently overriding the existing SDK/Tauri bans. A distinct-named rule composes cleanly.

## Incorrect

```ts
import { thing } from '@nightcore/contracts/internal/thing';
export { x } from '@nightcore/engine/src/sdk-adapter';
```

## Correct

```ts
import { TaskSchema } from '@nightcore/contracts';
```

If a deep entry is genuinely intended, add an explicit `exports` subpath to the target package and import that public subpath.
