# apps/web — Agent Contract

Guardrails enforced by `@nightcore/eslint-plugin` (scoped in the root `eslint.config.mjs`) and `tools/lint-meta`. Error or off, never warn.

## Folder-per-component
- A feature component is a folder `components/<feature>/<Name>/` containing the full sibling set: `<Name>.tsx`, `<Name>.hooks.ts`, `<Name>.types.ts`, `<Name>.stories.tsx`, `<Name>.test.tsx`, `index.ts` (enforced by `nightcore/component-folder-structure`). A component is not done until all six exist and pass.
- The first path segment under `components/` IS the feature — there is NO `features/` wrapper and NO nested `components/` segment.
- File names derive mechanically from the PascalCase component name: `<Name>.<role>.ts[x]`. The props type is `<Component>Props`, declared/exported from `<Component>.types.ts`, imported via `import type`.
- `components/ui/**` is the ONLY exemption: stateless single-element shadcn primitives are flat PascalCase files. A composite `ui` widget with its own types/state gets its own folder and the full sibling set.
- State lives in the colocated `.hooks.ts`, never in the component body (`nightcore/no-state-in-component-body`).
- A component file stays a thin shell: the per-file hook budget is capped (`nightcore/max-hooks-per-file`) — lift extra state/effects into the colocated `.hooks.ts` or a child component.

## Feature isolation & layering
- A component in one feature folder MUST NOT import another feature's internals (`nightcore/no-cross-feature-imports`). Shared code goes to `@/lib`, `@/hooks`, or `components/ui`. Only the `app` composition root may cross feature boundaries.
- `components/ui` primitives are dependency-graph leaves: they accept data via props and MUST NOT import any feature folder or `@tauri-apps/*`. The banned feature list is derived from the `components/` directory tree at lint time — every feature folder is covered automatically.
- `lib/**` is the framework-neutral leaf BELOW the rendering layer: it MUST NOT import `@/components/**` (or `motion`) — not even `components/ui`. Data flows upward from lib to components, never back down.

## The single Tauri seam
- ONLY `apps/web/src/lib/bridge.ts` may import `@tauri-apps/api` / `@tauri-apps/plugin-*`. Every other module talks to the Rust core through `bridge.ts` — never call `invoke()`/`listen()` directly.
- One command, three coupled names: the Rust `#[tauri::command]` fn is snake_case, the `invoke('...')` string must equal that fn name byte-for-byte (the string is untyped — a one-sided rename surfaces only as a runtime "command not found"), and the bridge wrapper is the camelCase of the same verb+noun (`listTasks()` → `invoke('list_tasks')`).
- Generated Rust→TS IPC types are consumed through the bridge re-export, never imported from `./generated/*` or `**/lib/generated/*` directly. Never hand-edit `src/lib/generated/**` — change the Rust struct and regenerate via `cargo test`.
- The SDK is never imported here — go through `@nightcore/engine`.

## Testing
- Tests import from `vitest` and run in Vitest browser mode (real chromium), never jsdom. Render real stories via `composeStories` + `vitest-browser-react`.
- Query by accessible role/label/text and assert with `await expect.element(...)` — never `data-testid`. Cover at least one keyboard path for interactive components.