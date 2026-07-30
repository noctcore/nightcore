// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

/**
 * Nightcore documentation site.
 *
 * ## Why Starlight and not VitePress
 *
 * The repo runs a `bun audit` gate at `moderate` (`scripts/audit.ts`), and every
 * suppression there is a reviewed standing claim about reachability. VitePress's
 * only stable line (1.6.x) pins `vite ^5.4.x` through `@vitejs/plugin-vue@5`, and
 * that tree currently reports one HIGH plus three MODERATE advisories with no
 * fixed 5.x to move to — adopting it would have meant adding four new by-id
 * suppressions (including a high) to ship a docs site. Starlight on Astro 7
 * audits clean. See the PR for the full comparison.
 *
 * ## Deployment
 *
 * `site` + `base` are set for a GitHub Pages PROJECT site at
 * `https://noctcore.github.io/nightcore/`. Pages is deliberately NOT enabled on
 * the repository yet — see `.github/workflows/docs.yml` for the guard and
 * `docs/README` in the PR for the exact switches the owner has to flip.
 *
 * Both are overridable from the environment so a later move to a custom domain
 * (e.g. `nightcore.dev`) is a workflow env change, not a code change:
 *
 *   DOCS_SITE=https://nightcore.dev DOCS_BASE=/ bun run --filter @nightcore/docs build
 */
const site = process.env.DOCS_SITE ?? 'https://noctcore.github.io';
const base = process.env.DOCS_BASE ?? '/nightcore';

export default defineConfig({
  site,
  base,
  // GitHub Pages serves `/foo/` from `foo/index.html`; the directory format is
  // the one that survives that without a server-side rewrite.
  build: { format: 'directory' },
  integrations: [
    starlight({
      title: 'Nightcore',
      // Copied from docs/assets/readme-logo.svg so the site, the README, and the
      // browser tab are one mark. `public/favicon.svg` is the same file (Starlight
      // links `/favicon.svg` by default).
      logo: { src: './src/assets/logo.svg', alt: 'Nightcore' },
      description:
        'Full-loop autonomy inside an enforced harness — a local-first desktop studio that runs coding agents behind machine-enforced gates.',
      tagline: 'Governed autonomy for coding agents.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/noctcore/nightcore',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/noctcore/nightcore/edit/main/apps/docs/',
      },
      lastUpdated: true,
      // Alpha software documented honestly: every page inherits the banner, so a
      // reader who lands deep from a search engine still sees the status.
      credits: false,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { slug: 'start/what-is-nightcore' },
            { slug: 'start/install' },
            { slug: 'start/first-task' },
          ],
        },
        {
          label: 'The governed lifecycle',
          items: [
            { slug: 'lifecycle' },
            { slug: 'lifecycle/intake' },
            { slug: 'lifecycle/understand' },
            { slug: 'lifecycle/harden' },
            { slug: 'lifecycle/enforce' },
            { slug: 'lifecycle/verify' },
          ],
        },
        {
          label: 'Governance',
          items: [
            { slug: 'governance/gates' },
            { slug: 'governance/policy' },
            { slug: 'governance/isolation' },
            { slug: 'governance/receipts' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/task-kinds' },
            { slug: 'reference/scans' },
            { slug: 'reference/pr-review' },
            { slug: 'reference/council' },
            { slug: 'reference/providers' },
            { slug: 'reference/files-on-disk' },
            { slug: 'reference/architecture' },
            { slug: 'reference/limits' },
          ],
        },
      ],
    }),
  ],
});
