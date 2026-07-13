/**
 * The synthesis knowledge base — a compact reference injected into the single
 * Harness synthesis pass so it generates a GOOD, enforceable harness rather than
 * generic boilerplate. Distilled from the proven two-layer harness shipped in the
 * boringstack + shiroani repos: a custom ESLint plugin for architecture-level AST
 * rules, plus a separate `lint-meta` engine for everything ESLint can't reach, plus
 * an agent-read-first contract doc. Kept short (it is prompt context, not code).
 *
 * {@link hardeningReference} extends it with the hardening-catalog producer guidance
 * (docs/research/2026-07-02-hardening-module-catalog.md): the starter templates +
 * routing rules for the modules synthesis may propose as `tool-config` artifacts or
 * `agent-task` proposals. Profile-conditional (a function, not a const) so only the
 * variant matching the detected package manager / stack spends prompt budget.
 */
import type { RepoProfile } from '@nightcore/contracts';
export const HARNESS_REFERENCE: string = [
  'HARNESS REFERENCE — the proven patterns for an enforceable codebase harness.',
  '',
  'TWO LAYERS. A good harness is two complementary enforcement layers:',
  '',
  '1) A CUSTOM ESLINT PLUGIN — AST rules that enforce ARCHITECTURE, not style.',
  '   ESLint/Prettier already own formatting; the plugin owns structure. Good rules:',
  '   - folder-per-component: each component lives in its own folder with its',
  '     index/styles/tests; no loose sibling component files.',
  '   - no-cross-feature-imports: a feature may not import another feature\'s',
  '     internals — only its public barrel (or not at all).',
  '   - layer/import boundaries: enforce the allowed dependency direction (e.g. ui',
  '     may import core, core may not import ui); forbid upward + sideways imports.',
  '   - resource-prefix naming: files/symbols of a kind share a required prefix or',
  '     suffix (e.g. `*.route.ts`, `use*` hooks, `*Schema` zod).',
  '   - tenancy / transaction safety: every tenant-scoped query carries the tenant',
  '     filter; multi-step writes run in a transaction.',
  '   Rules use AST selectors, are registered via ESLint FLAT config, and are',
  '   autofixable wherever the fix is mechanical.',
  '',
  '   WORKED EXAMPLE — turning the convention "hooks must be named use* and live in',
  '   *.hooks.ts" into a real AST rule file (`rules/hooks-naming.js`):',
  '     /** @type {import("eslint").Rule.RuleModule} */',
  '     module.exports = {',
  '       meta: {',
  '         type: "problem",',
  '         docs: { description: "custom hooks must be named use* and live in *.hooks.ts" },',
  '         fixable: "code",',
  '         schema: [],',
  '         messages: { badName: "Custom hook \'{{name}}\' must start with \'use\'." },',
  '       },',
  '       create(context) {',
  '         const filename = context.filename ?? context.getFilename();',
  '         if (!filename.endsWith(".hooks.ts") && !filename.endsWith(".hooks.tsx")) return {};',
  '         return {',
  '           // selector: exported function declarations in a *.hooks.ts file',
  '           "ExportNamedDeclaration > FunctionDeclaration[id.name=/^(?!use)/]"(node) {',
  '             context.report({',
  '               node: node.id,',
  '               messageId: "badName",',
  '               data: { name: node.id.name },',
  '               // optional mechanical fix: prefix the identifier with "use"',
  '               fix: (fixer) =>',
  '                 fixer.replaceText(',
  '                   node.id,',
  '                   "use" + node.id.name[0].toUpperCase() + node.id.name.slice(1),',
  '                 ),',
  '             });',
  '           },',
  '         };',
  '       },',
  '     };',
  '   Ship it with a `tests/hooks-naming.test.js` RuleTester fixture (valid: `useFoo`',
  '   in `x.hooks.ts`; invalid: `foo` → expects the `badName` message) so the plugin',
  '   self-verifies before a human makes it load-bearing. The plugin entry `index.js`',
  '   does `module.exports = { rules: { "hooks-naming": require("./rules/hooks-naming") } };`.',
  '',
  '2) A "LINT-META" ENGINE — a separate TS rule engine for what ESLint CANNOT reach:',
  '   cross-file contracts, non-JS files (configs, markdown, CI yaml), and config',
  '   parity across a monorepo. A generated `lint-meta-rule` file imports its rule type',
  "   from the PUBLISHED runner — `import type { IMetaRule } from '@noctcore/harness'`",
  '   (NOT a repo-local types file), so the SAME rule enforces in-repo AND under',
  '   `npx @noctcore/harness lint-meta` in plain CI. A rule is',
  "   `{ id; category: 'config'|'source-text'|'supply-chain'|'ci'|'testing'; description;",
  '   ciCritical?; run(ctx): IViolation[] }`, `IViolation` is `{ file; rule; message }`.',
  '   A `registry.ts` exports `META_RULES: IMetaRule[]` (loaded from the fixed',
  '   `.nightcore/lint-meta/registry.js`), a CLI runs them and exits non-zero on a',
  '   `ciCritical` violation, and a generated `RULES.md` catalogs them.',
  '',
  'AGENT_CONTRACT. A per-app, agent-read-FIRST markdown doc (CLAUDE.md / AGENTS.md /',
  'AGENT_CONTRACT.md) that lists every guardrail, the file-suffix conventions, and the',
  'forbidden imports — in the imperative, so an agent applies them without rediscovery.',
  'A lint-meta rule enforces the doc stays 1:1 with package.json (contract parity): if',
  'a guardrail is dropped from the doc but still wired, CI fails.',
  '',
  'AI-FIRST SEVERITY PHILOSOPHY: "error or off, never warn." Agents iterate by reading',
  'CI failures; a warning is a silent miss an agent will not act on. Hard-DENY the',
  'escape hatches that let an agent dodge the type system: `any`, `as` casts, and',
  'non-null `!`. A rule that matters is an error; a rule that does not is removed.',
  '',
  'SCOPING. Only propose the plugin + lint-meta layers when there is a monorepo or an',
  'existing eslint setup to host them; for a small single package, a tight',
  'AGENT_CONTRACT plus a few flat-config rules is the right-sized harness. Reuse what',
  'already exists (an existing plugin, lint-meta dir, or agent doc) — extend it, do not',
  'duplicate it.',
].join('\n');

/** The package manager implied by the detected workspace tool, when unambiguous.
 *  `turbo`/`nx` label the ORCHESTRATOR, not the package manager, so they (like
 *  `single`/`unknown`) fall back to read-the-lockfile guidance rather than a guess. */
function packageManagerOf(
  tool: RepoProfile['workspaceTool'],
): 'bun' | 'pnpm' | 'yarn' | 'npm' | undefined {
  return tool === 'bun' || tool === 'pnpm' || tool === 'yarn' || tool === 'npm'
    ? tool
    : undefined;
}

/** The honest lockfile-integrity check per package manager. npm/yarn lockfiles have a
 *  real linter (lockfile-lint: https, allowed registry hosts); pnpm/bun do NOT — for
 *  those the truthful check is the frozen-lockfile install their own CLI ships, which
 *  fails when the lockfile drifts from the manifest. Never suggest lockfile-lint for a
 *  lockfile format it cannot parse. */
const LOCKFILE_CHECK_COMMANDS: Record<'bun' | 'pnpm' | 'yarn' | 'npm', string> = {
  npm: 'npx lockfile-lint --path package-lock.json --type npm --validate-https --allowed-hosts npm',
  yarn: 'npx lockfile-lint --path yarn.lock --type yarn --validate-https --allowed-hosts npm yarn',
  pnpm: 'pnpm install --frozen-lockfile --ignore-scripts',
  bun: 'bun install --frozen-lockfile',
};

/**
 * The hardening-catalog producer guidance appended to {@link HARNESS_REFERENCE} in the
 * synthesis prompt. Encodes, per module, WHICH SHAPE the output must take — this is the
 * security routing, not style: a standalone config file is a `tool-config` `create`
 * artifact (one new file through the hardened Rust apply path), while ANYTHING that can
 * auto-run code (package.json scripts, git hooks, lefthook/husky, CI, installs) must be
 * an `agent-task` proposal, because the apply path DENIES those targets and the human
 * gate for them is a reviewed worktree diff, not a one-click write. Templates are
 * deliberately conservative: commented examples over invented file paths, no claims the
 * profile can't support. Kept compact — prompt context, not documentation.
 */
export function hardeningReference(profile: RepoProfile): string {
  const pm = packageManagerOf(profile.workspaceTool);
  // "Node-ish" = there is a JS/TS package surface for the JS-only modules (depcruise,
  // .npmrc, zod env schema, Stryker) to attach to. Detected typescript, a node package
  // manager, or any package.json-derived framework all imply one.
  const isNode =
    pm !== undefined ||
    profile.workspaceTool === 'turbo' ||
    profile.workspaceTool === 'nx' ||
    profile.languages.includes('typescript') ||
    profile.frameworks.length > 0;
  const runner = pm ?? 'npm';

  const lines: string[] = [
    'HARDENING MODULES — the codebase-hardening catalog. Propose the modules below when',
    'the profile/findings support them; skip any whose stack is absent. A standalone',
    'config FILE ships as a kind:"tool-config" `create` artifact at a NEW path — never',
    'propose one for a file already in the repo map (create refuses to overwrite).',
    'ANYTHING that can auto-run code (package.json scripts, git hooks, lefthook/husky,',
    'CI, editor/agent config, devcontainers, installs, shell scripts) must be an',
    '`agent-task` proposal instead — the',
    'apply path REJECTS those targets. Attach each suggested `harnessCheck` to the',
    'proposal whose work makes its command pass, and never claim a tool is installed',
    'unless you saw it in the repo.',
    '',
    'SECRET HYGIENE — tool-config `.gitleaks.toml`:',
    '  title = "gitleaks"',
    '  [extend]',
    '  useDefault = true # keep the maintained default ruleset; this file only ADDS allowlist entries',
    '  [allowlist]',
    '  description = "Known-safe paths/patterns, human-reviewed"',
    "  # paths = ['''(^|/)test/fixtures/''']",
    "  # regexes = ['''EXAMPLE_[A-Z_]+''']",
    'Keep allowlist entries commented unless you SAW the fixture path. On its proposal',
    'suggest harnessCheck { "name": "secret-scan", "kind": "secret-scan", "command": "gitleaks detect --no-banner --redact" }.',
    '',
  ];

  if (isNode) {
    lines.push(...importBoundaryModule(profile), '');
  }

  lines.push(...astGrepPolicyModule(profile), '');

  if (
    profile.languages.includes('typescript') &&
    profile.packages.some((p) => p.role === 'package')
  ) {
    lines.push(...apiExtractorModule(profile), '');
  }

  lines.push(
    'CHANGED-LINES COVERAGE GATE — agent-task only: wire the test runner to emit a',
    'report diff-cover reads (Cobertura XML or LCOV) and add diff-cover so only the',
    "agent's own diff must clear the bar; verifyCommand + harnessCheck",
    '{ "kind": "coverage-threshold", "command": "npx diff-cover coverage/coverage.xml --fail-under=80" }',
    '(match the report path the runner really writes' +
      (pm === 'bun'
        ? '; bun: `bun test --coverage --coverage-reporter=lcov` emits coverage/lcov.info).'
        : ').'),
    '',
  );

  if (isNode) {
    lines.push(...dependencyFirewallModule(pm), '');
    lines.push(
      'ENV-VAR CONTRACT — tool-config `env.schema.ts` (beside the real source entry you',
      'saw, e.g. `src/env.schema.ts`) + agent-task:',
      '  import { z } from "zod";',
      '  export const envSchema = z.object({',
      '    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),',
      '    // one entry per variable the code actually reads (grep process.env):',
      '    // DATABASE_URL: z.string().url(),',
      '  });',
      '  export const env = envSchema.parse(process.env);',
      'List ONLY variables you saw read in code. The agent-task wires the schema at the',
      'entry point (installing zod if absent), adds an `env:check` script that fails when',
      '`.env.example` drifts from the schema, and syncs `.env.example`; verifyCommand +',
      `harnessCheck { "kind": "env-contract", "command": "${runner} run env:check" }.`,
      '',
    );
  }

  lines.push(
    'CHARACTERIZATION TESTS — agent-task, ONLY when you can NAME concrete high-fan-in,',
    'low/no-coverage modules you actually read: cite the paths + the evidence in the',
    'prompt. With no grounded candidate, SKIP this module entirely — never fabricate',
    'targets. The prompt: write golden-master tests pinning the CURRENT behavior of',
    "those modules before agents change them; verifyCommand = the project's test command.",
    '',
  );

  if (isNode) {
    lines.push(
      'MUTATION-SCORE AUDIT — agent-task: set up Stryker (@stryker-mutator) with',
      '`incremental: true`, `mutate` scoped to the critical paths identified above;',
      'harnessCheck { "kind": "mutation-score", "command": "npx stryker run" }.',
      '',
    );
  } else {
    lines.push(
      'JS-only modules (import-boundary lock, dependency firewall, env contract,',
      'mutation audit) do not apply to this stack — skip them.',
      '',
    );
  }

  lines.push(
    'COMMIT DISCIPLINE — agent-task ONLY, never artifacts: lefthook/husky/commitlint',
    'configs drive git hooks, so even a NEW `lefthook.yml` is execution-adjacent and',
    'the apply path rejects it. The prompt: add lefthook + @commitlint/{cli,',
    'config-conventional} as devDependencies, a `lefthook.yml` with a commit-msg',
    'commitlint hook (plus the lint/test gates that already exist), a commitlint',
    'config, and run `lefthook install`.',
    '',
  );

  lines.push(...sandboxContainmentModule(), '');

  lines.push(
    'AGENT-CONTRACT BUDGET — every `agent-contract` artifact you propose is COMPILED,',
    'not accumulated: keep the managed section under ~150 lines of imperative,',
    'project-specific rules an agent can act on. Ban filler ("write clean code",',
    'restating defaults) and anything derivable from configs the agent already reads',
    '(tsconfig, lint rules). When the honest content exceeds the budget, keep the',
    'contract as a ranked index and move the overflow to satellite docs it links',
    '(e.g. docs/agent/testing.md) via an agent-task.',
  );

  return lines.join('\n');
}

/** Module #7 (import-boundary lock): the `.dependency-cruiser.cjs` starter. When the
 *  profile OBSERVED an apps/packages layering, the one boundary it proves is emitted as
 *  a live rule; otherwise the layer rule stays a commented example — a rule the profile
 *  can't support must be human-authored, not fabricated. */
function importBoundaryModule(profile: RepoProfile): string[] {
  const hasAppsAndPackages =
    profile.packages.some((p) => p.role === 'app') &&
    profile.packages.some((p) => p.role === 'package');
  // The depcruise scan roots: the observed top-level member dirs for a monorepo, the
  // conventional `src` (to be corrected against the repo map) otherwise.
  const roots = profile.isMonorepo
    ? [...new Set(profile.packages.map((p) => p.path.split('/')[0] ?? p.path))].join(' ') ||
      'src'
    : 'src';
  return [
    'IMPORT-BOUNDARY LOCK — tool-config `.dependency-cruiser.cjs` + agent-task:',
    '  module.exports = { forbidden: [',
    '    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },',
    ...(hasAppsAndPackages
      ? [
          '    { name: "packages-not-into-apps", severity: "error",',
          '      from: { path: "^packages" }, to: { path: "^apps" } },',
        ]
      : [
          '    // add layer rules ONLY for boundaries you observed, e.g.:',
          '    // { name: "ui-not-into-server", severity: "error",',
          '    //   from: { path: "^src/ui" }, to: { path: "^src/server" } },',
        ]),
    '  ], options: { doNotFollow: { path: "node_modules" } } };',
    'Derive further rules from the imports-boundaries findings above. PLUS an',
    'agent-task: install `dependency-cruiser` as a devDependency and wire a script;',
    'verifyCommand + harnessCheck',
    `{ "kind": "dependency-cruiser", "command": "npx depcruise ${roots}" } (swap in the real source roots).`,
  ];
}

/** Module #11 (dependency firewall), branched per package manager because the honest
 *  pin config differs: npm/pnpm read `.npmrc` (a safe NEW-file artifact — NOT on the
 *  apply-path denylist), bun ignores dependency lifecycle scripts by default, and yarn
 *  berry's `.yarnrc.yml` usually already exists (create would refuse) so it routes via
 *  agent-task. Always closes with the lockfile check + the policy.denyBashPatterns
 *  note — proposals must NEVER write policy themselves, only describe the pattern. */
function dependencyFirewallModule(
  pm: 'bun' | 'pnpm' | 'yarn' | 'npm' | undefined,
): string[] {
  const lines: string[] = [];
  if (pm === 'npm' || pm === 'pnpm') {
    lines.push(
      'DEPENDENCY FIREWALL — tool-config `.npmrc`:',
      '  ignore-scripts=true',
      '  save-exact=true',
      "Warn in its description that ignore-scripts also skips the repo's OWN lifecycle",
      'scripts — the human decides.',
    );
  } else if (pm === 'bun') {
    lines.push(
      'DEPENDENCY FIREWALL — bun runs dependency lifecycle scripts only for',
      '`trustedDependencies`, so skip the `.npmrc` artifact for bun.',
    );
  } else if (pm === 'yarn') {
    lines.push(
      'DEPENDENCY FIREWALL — yarn reads `.yarnrc.yml` (`enableScripts: false`), which',
      'usually already exists: route that change via agent-task, not an artifact.',
    );
  } else {
    lines.push(
      'DEPENDENCY FIREWALL — if the lockfile is npm’s or pnpm’s, propose a tool-config',
      '`.npmrc` artifact with `ignore-scripts=true` + `save-exact=true` (warn it also',
      "skips the repo's own lifecycle scripts).",
    );
  }
  if (pm !== undefined) {
    lines.push(
      `Suggest harnessCheck { "kind": "lockfile-lint", "command": "${LOCKFILE_CHECK_COMMANDS[pm]}" }` +
        (pm === 'pnpm' || pm === 'bun'
          ? ' (lockfile-lint cannot parse this lockfile; the frozen-lockfile install is the honest integrity check).'
          : '.'),
    );
  } else {
    lines.push(
      'Suggest harnessCheck { "kind": "lockfile-lint", "command": <per the lockfile in',
      `the repo map> }: package-lock.json → "${LOCKFILE_CHECK_COMMANDS.npm}";`,
      `yarn.lock → "${LOCKFILE_CHECK_COMMANDS.yarn}";`,
      `pnpm-lock.yaml → "${LOCKFILE_CHECK_COMMANDS.pnpm}"; bun.lock →`,
      `"${LOCKFILE_CHECK_COMMANDS.bun}" (lockfile-lint cannot parse pnpm/bun lockfiles).`,
    );
  }
  lines.push(
    'Install-command interception (blocking new-package installs mid-task) belongs in',
    'the `policy.denyBashPatterns` key of `.nightcore/harness.json` — proposals NEVER',
    'write policy; instead put the example pattern',
    '"\\\\b(npm|pnpm|yarn|bun)\\\\s+(add|install)\\\\b" in the proposal DESCRIPTION so the',
    'human can add it themselves.',
  );
  return lines;
}

/** Module #18 (ast-grep policy pack): `sgconfig.yml` + starter rule files under
 *  `ast-grep-rules/`. ast-grep is tree-sitter based and language-agnostic, so the module
 *  is offered on every stack — but the starter rule must stay GROUNDED (the
 *  dependency-cruiser honesty pattern): a TypeScript repo gets the one rule that is true
 *  everywhere (`debugger` must not ship); any other stack writes a rule only for a
 *  pattern the findings actually name. CLI facts verified against ast-grep 0.44: the npm
 *  package `@ast-grep/cli` ships TWO bins (`ast-grep`, `sg`), so bare `npx @ast-grep/cli`
 *  fails with "could not determine executable" — the runnable form is
 *  `npx --yes --package=@ast-grep/cli ast-grep …`; `scan` reads `sgconfig.yml` from the
 *  cwd, and `--error` escalates every rule to error severity and exits 1 on any match. */
function astGrepPolicyModule(profile: RepoProfile): string[] {
  const hasTs = profile.languages.includes('typescript');
  return [
    'AST-GREP POLICY PACK — tool-config `sgconfig.yml` + starter rule files under',
    '`ast-grep-rules/` (inert YAML — nothing runs them until the check below is wired):',
    '  sgconfig.yml:',
    '    ruleDirs:',
    '      - ast-grep-rules',
    ...(hasTs
      ? [
          '  ast-grep-rules/no-debugger.yml:',
          '    id: no-debugger',
          '    language: TypeScript',
          '    severity: error',
          '    message: debugger statements must not ship',
          '    rule:',
          '      pattern: debugger',
        ]
      : [
          '  Write the starter rule ONLY for a pattern the findings actually name, in the',
          '  dominant language you observed (ast-grep is tree-sitter based — rust/python/go',
          '  rules are fine). With no grounded pattern, propose just the config + the',
          '  agent-task and let the human author the first rule.',
        ]),
    'At most one or two further rules, each grounded in a specific finding (cite it in',
    'sourceFindings) — an invented policy is a false gate. PLUS an agent-task: add',
    '`@ast-grep/cli` as a devDependency (or keep the npx form), wire a script, and run',
    'the scan once; verifyCommand + harnessCheck { "kind": "ast-grep", "command":',
    '"npx --yes --package=@ast-grep/cli ast-grep scan --error" } (the package ships two',
    'bins so plain `npx @ast-grep/cli` cannot resolve one; `scan` reads `sgconfig.yml`',
    'from the cwd and `--error` escalates every rule, exiting 1 on any match).',
  ];
}

/** Module #18 (api-extractor surface lock): ONLY for a TypeScript LIBRARY package — the
 *  profile must show a `package`-role member to anchor it (an app has no public API
 *  surface to lock), and the observed member path grounds the config location + `-c`
 *  flag. Verified semantics (api-extractor 7.58, api-extractor.com): `run --local`
 *  UPDATES the committed `etc/<name>.api.md` when the surface changed ("Updating
 *  'etc/….api.md'"), while WITHOUT `--local` (the CI/gate form) an out-of-date report is
 *  an ERROR — so the agent-task seeds the report with `--local` and the armed check runs
 *  without it. */
function apiExtractorModule(profile: RepoProfile): string[] {
  const lib = profile.packages.find((p) => p.role === 'package');
  const root = lib?.path ?? 'packages/<name>';
  return [
    'API SURFACE LOCK — ONLY for a TypeScript LIBRARY package whose public entry you',
    `actually saw (a package-role member, e.g. ${root}): tool-config`,
    `\`${root}/api-extractor.json\`:`,
    '  {',
    '    "$schema": "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",',
    '    "mainEntryPointFilePath": "<projectFolder>/dist/index.d.ts",',
    '    "apiReport": { "enabled": true, "reportFolder": "<projectFolder>/etc/" },',
    '    "docModel": { "enabled": false },',
    '    "dtsRollup": { "enabled": false }',
    '  }',
    'Point `mainEntryPointFilePath` at the REAL built declaration entry (read the',
    'package\'s `types`/`exports` fields and its build output dir) — a guessed path fails',
    'the first run. PLUS an agent-task: install `@microsoft/api-extractor` as a',
    'devDependency, build the package, then generate + COMMIT the initial report with',
    `\`npx --yes @microsoft/api-extractor run --local -c ${root}/api-extractor.json\``,
    '(LOCAL mode writes/updates `etc/<name>.api.md`); verifyCommand + harnessCheck',
    `{ "kind": "api-extractor", "command": "npx --yes @microsoft/api-extractor run -c ${root}/api-extractor.json" }`,
    '— WITHOUT `--local` an out-of-date committed report is an ERROR, which is the gate',
    'form (it compares against built `.d.ts`, so the wiring must keep a build step ahead',
    'of it).',
  ];
}

/** Module #15 (sandbox tier): OS-level write containment around agent runs. The in-app
 *  workspace gate is LEXICAL with documented residual gaps (symlink hops, shell
 *  redirects/heredocs, MCP-server writers), and OS containment is the honest fix. Ships
 *  as ONE inert config artifact (a Seatbelt profile nothing loads until a human runs
 *  `sandbox-exec -f` themselves) plus two agent-tasks for the pieces that are
 *  execution-adjacent by nature: a devcontainer runs postCreate/onCreate hooks (its
 *  basename is on the apply-path denylist, so a synthesized artifact can never write
 *  one), and a launcher script is shell. */
function sandboxContainmentModule(): string[] {
  return [
    'AGENT SANDBOX TIER — OS-level write containment for agent runs. Be honest in every',
    'description about the tier: lexical workspace gates have documented gaps (symlink',
    'hops, shell redirects, MCP-server writers) — OS containment closes the WRITE vector;',
    'it does not by itself contain network or secret exfiltration.',
    '  (a) tool-config `sandbox/agent.sb` — a macOS Seatbelt deny-write-except profile:',
    '    (version 1)',
    '    (allow default)',
    '    (deny file-write*)',
    '    (allow file-write* (subpath "__WORKSPACE_ROOT__"))',
    '    (allow file-write* (subpath "/private/tmp"))',
    '    (allow file-write* (subpath "/private/var/folders"))',
    '  INERT config: nothing loads it until a human explicitly runs',
    '  `sandbox-exec -f sandbox/agent.sb <command>`. The DESCRIPTION must tell the user',
    '  to replace __WORKSPACE_ROOT__ with the absolute workspace path (Seatbelt profiles',
    '  do no env expansion) and note Apple marks `sandbox-exec` deprecated-but-working.',
    '  (b) agent-task ONLY: propose a `.devcontainer/devcontainer.json` for',
    '  container-level isolation. devcontainers carry postCreateCommand/onCreateCommand',
    '  hooks, so the file is execution-adjacent — the apply path DENIES its basename;',
    '  never emit it as an artifact.',
    '  (c) agent-task ONLY: a Linux bubblewrap launcher script, e.g.',
    '  `scripts/agent-sandbox.sh` wrapping `bwrap --ro-bind / / --bind <workspace>',
    '  <workspace> --dev /dev --proc /proc --unshare-all --share-net -- <command>` — a',
    '  shell script is execution-adjacent.',
  ];
}
