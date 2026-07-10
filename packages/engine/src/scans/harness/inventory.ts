/**
 * Deterministic, fs-only rule-inventory extraction for the Harness ENFORCE-lite
 * coverage capability — a cheap synchronous filesystem pass (no Claude, no SDK)
 * that discovers what the TARGET repo already ENFORCES: ESLint rules wired at
 * `error`/`warn`, lint-meta rule ids, armed Structure-Lock gauntlet checks, and
 * the guardrail CLAIMS in its agent docs (CLAUDE.md / AGENTS.md). It is the input
 * to the coverage join (`coverage.ts`), which decides per convention whether an
 * enforcing rule exists (`enforced`), only a doc claim does (`documented-only`),
 * or nothing (`unenforced`).
 *
 * Generalizes the `agent-contract-parity` lint-meta idiom (glob the config, grep
 * the rule ids, glob the docs, diff the claims) to any repo. Best-effort by design
 * — a Phase-1 honest limit is that computed/flat ESLint configs that build their
 * rule map dynamically are only visible via `eslint --print-config` (a Rust exec
 * seam, deferred); this textual parse sees the rules written as literals. Every
 * read is try/catch and NEVER throws: a missing/garbage file collapses to empty,
 * mirroring the degrade-not-throw discipline of `repo-profile.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The enforcement inventory the coverage join consumes. */
export interface RuleInventory {
  /** Distinct enforcing rule ids discovered (ESLint rules at `error`/`warn` +
   *  lint-meta rule ids + armed gauntlet-check names), sorted. A convention that
   *  maps to one of these is `enforced`. */
  ruleIds: string[];
  /** Guardrail CLAIM lines parsed from the repo's agent docs (headings, bullet
   *  rules, backticked rule names). A convention that maps only to one of these —
   *  with no matching `ruleId` — is `documented-only`. */
  docClaims: string[];
  /** Distinct enforcing-rule count — the "inventory: N rules found" caption the UI
   *  surfaces (`ruleIds.length`). */
  count: number;
}

/** Cap per source so a pathological repo can't flood the join prompt. */
const MAX_RULE_IDS = 300;
const MAX_DOC_CLAIMS = 120;
const MAX_DOC_CLAIM_LEN = 200;
const MAX_LINT_META_FILES = 200;

/** Candidate lint-meta `rules/` dirs (repo-relative), mirroring `repo-profile`'s
 *  `detectLintMeta` locations. Each existing one is scanned for rule ids. */
const LINT_META_RULE_DIRS = [
  'tools/lint-meta/rules',
  'tools/lint-meta/src/rules',
  'lint-meta/rules',
  'tooling/lint-meta/rules',
  'scripts/lint-meta/rules',
  'packages/lint-meta/rules',
  'packages/lint-meta/src/rules',
];

/** Agent-doc basenames scanned for guardrail claims (root + member dirs). */
const AGENT_DOC_BASENAMES = ['CLAUDE.md', 'AGENTS.md', 'AGENT_CONTRACT.md'];

/** ESLint flat-config basenames scanned for wired rule ids (root + member dirs). */
const ESLINT_CONFIG_BASENAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
];

export interface ExtractRuleInventoryOptions {
  /** Repo-relative workspace-member dirs to also scan (the Harness profile's
   *  `packages[].path`), so a monorepo's per-package eslint configs + agent docs
   *  are included, not just the root. */
  packageDirs?: string[];
}

/**
 * Extract the deterministic {@link RuleInventory} of the repo rooted at
 * `projectPath`. Pure synchronous fs reads; never throws.
 */
export function extractRuleInventory(
  projectPath: string,
  options: ExtractRuleInventoryOptions = {},
): RuleInventory {
  const root = path.resolve(projectPath);
  const scanDirs = [
    root,
    ...(options.packageDirs ?? []).map((rel) => path.resolve(root, rel)),
  ];

  const ruleIds = new Set<string>();
  // ESLint rules wired at error|warn, across root + members.
  for (const dir of scanDirs) {
    for (const base of ESLINT_CONFIG_BASENAMES) {
      const text = readText(path.join(dir, base));
      if (text === undefined) continue;
      for (const id of parseEslintRuleIds(text)) ruleIds.add(id);
    }
  }
  // lint-meta rule ids.
  for (const id of collectLintMetaRuleIds(root)) ruleIds.add(id);
  // Armed Structure-Lock gauntlet checks (`.nightcore/harness.json`).
  for (const name of collectArmedCheckNames(root)) ruleIds.add(name);

  // Agent-doc guardrail claims, across root + members.
  const docClaims = new Set<string>();
  for (const dir of scanDirs) {
    for (const base of AGENT_DOC_BASENAMES) {
      const text = readText(path.join(dir, base));
      if (text === undefined) continue;
      for (const claim of parseDocClaims(text)) docClaims.add(claim);
    }
  }

  const rules = [...ruleIds].sort().slice(0, MAX_RULE_IDS);
  return {
    ruleIds: rules,
    docClaims: [...docClaims].slice(0, MAX_DOC_CLAIMS),
    count: rules.length,
  };
}

/**
 * Textually extract ESLint rule ids wired at `error`/`warn` (or the numeric `2`/`1`)
 * from a flat-config source. Matches `'<rule-id>': 'error'`, `"<rule-id>": 2`,
 * `'<rule-id>': ['warn', …]`, etc. Best-effort: a rule whose severity is COMPUTED
 * (a variable, a spread, `...config.rules`) is invisible to a textual parse — the
 * Phase-1 honest limit. Keys that don't look like rule ids (camelCase config keys)
 * are dropped to cut noise.
 */
export function parseEslintRuleIds(text: string): string[] {
  const out: string[] = [];
  // Match `'<rule-id>': 'error'|"warn"|['error',…]|2|1`. The severity is either a
  // quoted `error`/`warn` (the quotes delimit it — a trailing `\b` never matches
  // after a quote) or a bare `2`/`1` not followed by another digit.
  const re =
    /['"]([@A-Za-z][\w@/.-]*)['"]\s*:\s*(?:\[\s*)?(?:['"](?:error|warn)['"]|[12](?!\d))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (id !== undefined && looksLikeRuleId(id)) out.push(id);
  }
  return out;
}

/** Whether a quoted config key looks like an ESLint rule id: a plugin rule
 *  (`plugin/rule`, `@scope/plugin/rule`) or a lowercase core rule (`no-console`,
 *  `eqeqeq`). The lowercase-only shape filters out camelCase config keys
 *  (`parserOptions`, `ecmaVersion`) a bare `key: 'error'` textual match could
 *  otherwise catch. */
function looksLikeRuleId(id: string): boolean {
  if (id.includes('/')) return true;
  return /^[a-z][a-z0-9-]*$/.test(id);
}

/** Collect lint-meta rule ids by reading each rule file under any known lint-meta
 *  `rules/` dir and extracting its `id: '…'`. Bounded + best-effort. */
function collectLintMetaRuleIds(root: string): string[] {
  const ids: string[] = [];
  let scanned = 0;
  for (const rel of LINT_META_RULE_DIRS) {
    const dir = path.join(root, rel);
    for (const file of listFiles(dir)) {
      if (!/\.(?:ts|js|mjs|cjs)$/.test(file) || file.includes('.test.')) continue;
      if (scanned >= MAX_LINT_META_FILES) break;
      scanned += 1;
      const text = readText(path.join(dir, file));
      if (text === undefined) continue;
      const m = /\bid:\s*['"]([a-z0-9][a-z0-9-]*)['"]/.exec(text);
      if (m?.[1] !== undefined) ids.push(m[1]);
    }
  }
  return ids;
}

/** Collect the names of the ENABLED Structure-Lock gauntlet checks armed in the
 *  project's `.nightcore/harness.json` (`checks[].name`). An armed check is real
 *  enforcement, so its name joins the rule inventory. */
function collectArmedCheckNames(root: string): string[] {
  const manifest = readJson(path.join(root, '.nightcore', 'harness.json'));
  const checks = manifest?.checks;
  if (!Array.isArray(checks)) return [];
  const names: string[] = [];
  for (const check of checks) {
    if (check === null || typeof check !== 'object') continue;
    const c = check as Record<string, unknown>;
    if (c.enabled === false) continue;
    if (typeof c.name === 'string' && c.name.trim().length > 0) {
      names.push(c.name.trim());
    }
  }
  return names;
}

/**
 * Parse guardrail CLAIM lines out of an agent doc: markdown headings, bullet
 * rules, and backtick-quoted rule names — the lines an agent reads as "the rules".
 * These feed the join so a convention with no lint rule but a matching doc claim is
 * `documented-only` (the `agent-contract-parity` insight inverted). Trimmed of
 * markdown syntax, length-capped, de-duplicated by the caller.
 */
export function parseDocClaims(text: string): string[] {
  const claims: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const isHeading = /^#{1,6}\s+/.test(line);
    const isBullet = /^[-*]\s+/.test(line);
    if (!isHeading && !isBullet) continue;
    const cleaned = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*]\s+/, '')
      .replace(/[`*_]/g, '')
      .trim();
    if (cleaned.length === 0) continue;
    claims.push(cleaned.slice(0, MAX_DOC_CLAIM_LEN));
  }
  return claims;
}

// ── fs primitives (all degrade-not-throw, mirroring repo-profile.ts) ─────────

function readText(absPath: string): string | undefined {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson(absPath: string): Record<string, unknown> | undefined {
  const text = readText(absPath);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Immediate file names of `absPath` (empty when unreadable). */
function listFiles(absPath: string): string[] {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
