# @nightcore/web

The React board — the UI tier of the Nightcore desktop studio. A thin client
rendered in a Tauri WebView; all IPC funnels through `src/lib/bridge.ts`
(`invoke` / `listen('nc:*')`). It never imports the Claude Agent SDK directly.

See [`docs/architecture.md`](../../docs/architecture.md) for the full 3-tier
model and dependency rules.

## Run / build / test

```bash
bun run web           # Vite dev server (browser preview; sidecar disabled)
bun run web:build     # production build
bun run test:web      # Vitest + Storybook component tests
bun run --filter @nightcore/web typecheck   # typecheck (root tsc -b does NOT cover this package)
bun run lint          # ESLint with the @nightcore/eslint-plugin folder-per-component rules
```
