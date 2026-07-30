# apps/docs — Agent Contract

The public documentation site (Astro + Starlight), published to GitHub Pages.
It is a **read-only surface**: it renders prose about the product and imports
nothing that could change the product's behaviour.

## The one rule that matters: do not restate the product

- **Never hand-copy a fact that already exists as data in the codebase.** The
  five-stage lifecycle is the live example: `scripts/gen-stages.ts` imports
  `apps/web/src/lib/stages.ts` at build time and writes `src/generated/stages.json`,
  which `src/components/StageTable.astro` renders. That generated file is
  git-ignored precisely so there is no committed copy to go stale. If a stage is
  renamed in the app, the next docs build changes with it.
- That relative import into `apps/web` is the **one declared seam** between the
  two surfaces. It is build-time only, it reads a pure-data module (no React, no
  imports of its own), and nothing from `apps/web` ships in the docs bundle. Any
  further cross-surface import needs the same treatment — a codegen script with a
  documented reason — not an ad-hoc `../../web/...` in a page.
- **Do not document behaviour you have not verified in the code.** A docs site
  asserting a feature that does not exist is worse than no docs site. Cite the
  path you checked in the PR when you add a capability claim, and prefer saying
  "not verified" to guessing. `reference/limits` exists to hold exactly that
  admission — keep it current rather than quietly dropping a caveat.

## Dependencies

- Every dependency stays in **this** `package.json`; nothing docs-only belongs in
  the root manifest. The site is a static build — no runtime dependency ships to
  a reader.
- `bun audit` (`bun run audit` at the root, gated at `moderate`) covers this
  workspace like any other. A docs dependency that needs a new by-id suppression
  in `scripts/audit.ts` is the wrong dependency — that is why this site is
  Starlight and not VitePress (whose only stable line pins a `vite 5.x` tree with
  unfixed advisories).
- Astro's `js-yaml` requirement is why the root `overrides` entry is bounded
  `>=4.3.0 <5`: the unbounded floor resolved js-yaml 5, which dropped the default
  export Astro imports. Security floors here stay **within a major**.

## Shape

- `src/content/docs/**` — the pages. Markdown/MDX only; a page that needs logic
  gets a component under `src/components/`.
- Internal links are written as **site-relative paths without the deploy base**
  (`start/install/`), so a later move to a custom domain is a `DOCS_BASE` change
  in `astro.config.mjs`, not a find-and-replace.
- `astro build` is the gate. `.astro/` and `src/generated/` are git-ignored
  build artefacts and are excluded from ESLint (generated code we cannot edit).
- The site is NOT in the root `tsconfig.json` project references — `bun run
  typecheck` (a root `tsc -b`) deliberately does not compile Astro's generated
  type surface, the same way it does not compile `apps/web`.

## Publishing

- `.github/workflows/docs.yml` **builds on every relevant push/PR** but only
  **deploys** when the repository variable `DOCS_PAGES_ENABLED` is `true`.
  Enabling GitHub Pages is the owner's outward-facing decision; do not enable
  Pages, do not set the repo homepage, and do not remove that guard.
