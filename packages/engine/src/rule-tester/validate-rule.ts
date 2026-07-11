/**
 * One-shot RuleTester validation runner (issue #185, item 1).
 *
 * Answers "is this armed lint-plugin check a real rule that actually fires, not a
 * placebo?" by loading a plugin rule and running it through ESLint's `RuleTester`
 * on demand. Lives in the Bun sidecar (this engine package), NOT the Rust desktop
 * crate: a Rust-spawned bare `node` can't load the TS/ESM/CJS rules Nightcore ships,
 * and `RuleTester`'s constructor API varies across ESLint versions — here we load
 * the TARGET project's own ESLint at runtime, so validation runs against its version.
 *
 * Everything is fail-SOFT: a rule that won't resolve, an ESLint that won't load, or a
 * RuleTester that won't construct is reported as a structured `outcome: 'error'`,
 * never a thrown crash. The Rust core reads the verdict off the `query-result` reply.
 *
 * ## Loading strategy (why runtime dynamic import, not a static `import 'eslint'`)
 *
 * The sidecar is shipped as a `bun build --compile` single-file binary. A static
 * `import { RuleTester } from 'eslint'` would bundle ESLint (huge, and it does
 * dynamic requires) INTO the binary and pin ONE version. Instead we resolve ESLint
 * and the rule module via COMPUTED paths (`createRequire(...).resolve` +
 * `pathToFileURL`), which the bundler leaves as runtime imports — so we load the
 * target project's real toolchain off disk. That is also what makes the runner
 * version-tolerant for free: whatever `RuleTester` the project ships is what runs.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RuleValidationResult, SurfaceQuery } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

/** The `validate-rule` query variant, narrowed from the `SurfaceQuery` union. */
type ValidateRuleQuery = Extract<SurfaceQuery, { type: 'validate-rule' }>;

/** The minimal shape we need from an ESLint module: the RuleTester constructor and
 *  (for a version diagnostic) the Linter's static `version`. Both are read
 *  defensively — a module missing either degrades, never throws. */
interface EslintModule {
  RuleTester?: RuleTesterCtor;
  Linter?: { version?: string };
  default?: EslintModule;
}

/** RuleTester's constructor + the one method we drive. Version-agnostic: the config
 *  shape differs across ESLint majors, so we type it loosely and try both shapes. */
interface RuleTesterCtor {
  new (config?: unknown): RuleTesterInstance;
  /** Static hooks RuleTester calls to sequence its cases. We override them so the run
   *  is synchronous and framework-independent (no ambient `bun:test` globals). */
  describe?: RuleTesterHook;
  it?: RuleTesterHook;
  itOnly?: RuleTesterHook;
}
type RuleTesterHook = (text: string, fn: () => void) => void;
interface RuleTesterInstance {
  run(name: string, rule: unknown, tests: RuleTesterSuites): void;
}
interface RuleTesterSuites {
  valid: unknown[];
  invalid: unknown[];
}

/** The two structural shapes a `rulePath` module can expose: a single rule module,
 *  or a plugin object carrying a `rules` map. */
interface PluginModule {
  rules?: Record<string, unknown>;
  default?: PluginModule;
}

/**
 * Run one `validate-rule` request through RuleTester and return a structured verdict.
 * Never throws — every failure path resolves to a `RuleValidationResult`.
 */
export async function validateRule(
  query: ValidateRuleQuery,
  logger?: Logger,
): Promise<RuleValidationResult> {
  const { ruleId, rulePath, ruleName, projectPath } = query;
  const validCases = query.validCases ?? [];
  const invalidCases = query.invalidCases ?? [];

  const base: RuleValidationResult = {
    ruleId,
    outcome: 'error',
    ruleLoaded: false,
    validPassed: 0,
    validTotal: validCases.length,
    invalidPassed: 0,
    invalidTotal: invalidCases.length,
    cases: [],
  };

  // 1. Load the target project's ESLint RuleTester (runtime import off disk).
  let loaded: LoadedRuleTester;
  try {
    loaded = await loadRuleTester(projectPath);
  } catch (error) {
    return {
      ...base,
      error: `could not load ESLint RuleTester: ${describeError(error)}`,
    };
  }
  const { RuleTester, eslintVersion } = loaded;
  base.eslintVersion = eslintVersion;

  // 2. Load the rule cross-toolchain (TS/ESM/CJS).
  let rule: unknown;
  try {
    rule = await loadRule(rulePath, ruleName ?? deriveRuleName(ruleId), projectPath);
  } catch (error) {
    return {
      ...base,
      error: `could not load rule '${ruleId}' from '${rulePath}': ${describeError(error)}`,
    };
  }
  if (!isEslintRule(rule)) {
    return {
      ...base,
      error: `'${ruleId}' resolved but is not an ESLint rule (no create() function)`,
    };
  }

  // 3. Construct RuleTester version-tolerantly + install synchronous run hooks.
  let tester: RuleTesterInstance;
  try {
    tester = makeRuleTester(RuleTester);
  } catch (error) {
    return {
      ...base,
      ruleLoaded: true,
      error: `could not construct RuleTester: ${describeError(error)}`,
    };
  }

  // 4. No cases supplied ⇒ a structural probe: confirm RuleTester accepts the rule
  //    as well-formed (validates meta/schema) without executing it on code.
  if (validCases.length === 0 && invalidCases.length === 0) {
    try {
      tester.run(ruleId, rule, { valid: [], invalid: [] });
      logger?.debug('validate-rule: structural probe passed', { ruleId });
      return { ...base, outcome: 'probed', ruleLoaded: true };
    } catch (error) {
      return {
        ...base,
        ruleLoaded: true,
        outcome: 'error',
        error: `RuleTester rejected the rule as malformed: ${describeError(error)}`,
      };
    }
  }

  // 5. Run each case in its own RuleTester call so a single failure is captured
  //    (RuleTester throws on the first failing assertion) without stopping the rest.
  const cases: RuleValidationResult['cases'] = [];
  let validPassed = 0;
  validCases.forEach((raw, index) => {
    const result = runCase(tester, ruleId, rule, 'valid', parseValidCase(raw));
    if (result.passed) validPassed += 1;
    cases.push({ kind: 'valid', index, passed: result.passed, ...messageOf(result) });
  });
  let invalidPassed = 0;
  invalidCases.forEach((raw, index) => {
    const result = runCase(tester, ruleId, rule, 'invalid', parseInvalidCase(raw));
    if (result.passed) invalidPassed += 1;
    cases.push({ kind: 'invalid', index, passed: result.passed, ...messageOf(result) });
  });

  const allPassed =
    validPassed === validCases.length && invalidPassed === invalidCases.length;
  return {
    ...base,
    ruleLoaded: true,
    outcome: allPassed ? 'passed' : 'failed',
    validPassed,
    invalidPassed,
    cases,
  };
}

// ---------------------------------------------------------------------------
// RuleTester loading (target-project ESLint, resolved off disk at runtime)
// ---------------------------------------------------------------------------

interface LoadedRuleTester {
  RuleTester: RuleTesterCtor;
  eslintVersion: string | undefined;
}

/** Resolve + import the ESLint module, preferring the target project's copy so the
 *  RuleTester version matches what the project's plugin was authored against. */
async function loadRuleTester(projectPath?: string): Promise<LoadedRuleTester> {
  const specifiers = eslintSpecifiers(projectPath);
  let lastError: unknown;
  for (const specifier of specifiers) {
    try {
      const mod = (await import(specifier)) as EslintModule;
      const RuleTester = mod.RuleTester ?? mod.default?.RuleTester;
      if (typeof RuleTester === 'function') {
        const eslintVersion = mod.Linter?.version ?? mod.default?.Linter?.version;
        return { RuleTester, eslintVersion };
      }
      lastError = new Error(`module '${specifier}' has no RuleTester export`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('eslint could not be resolved');
}

/** Candidate ESLint module specifiers, most-specific first: the target project's
 *  copy, then the engine cwd's copy. All are COMPUTED (resolved file URLs, or a
 *  non-literal bare specifier) so the bundler leaves them as runtime imports rather
 *  than embedding ESLint in the compiled sidecar. */
function eslintSpecifiers(projectPath?: string): string[] {
  const specifiers: string[] = [];
  const roots = [projectPath, process.cwd()].filter(
    (root): root is string => typeof root === 'string' && root.length > 0,
  );
  for (const root of roots) {
    try {
      const require = createRequire(path.join(path.resolve(root), 'noop.js'));
      specifiers.push(pathToFileURL(require.resolve('eslint')).href);
    } catch {
      // This root has no resolvable eslint; try the next.
    }
  }
  // Last resort (dev / non-compiled): a computed bare specifier the bundler can't
  // statically inline, resolved against the runtime's node_modules.
  specifiers.push(['es', 'lint'].join(''));
  return [...new Set(specifiers)];
}

// ---------------------------------------------------------------------------
// Rule loading (cross-toolchain: TS/ESM/CJS, single-rule OR plugin module)
// ---------------------------------------------------------------------------

/** Import `rulePath` and extract the rule object. Handles a single-rule module
 *  (default or namespace export) and a plugin exposing a `.rules` map. */
async function loadRule(
  rulePath: string,
  ruleName: string,
  projectPath?: string,
): Promise<unknown> {
  const absolute = path.isAbsolute(rulePath)
    ? rulePath
    : path.resolve(projectPath ?? process.cwd(), rulePath);
  const mod = (await import(pathToFileURL(absolute).href)) as PluginModule;

  // Plugin shape: `{ rules: { <name>: rule } }` (possibly under `default`).
  const rules = mod.rules ?? mod.default?.rules;
  if (rules && typeof rules === 'object') {
    const fromPlugin = rules[ruleName];
    if (fromPlugin !== undefined) return fromPlugin;
    throw new Error(
      `plugin has no rule named '${ruleName}' (has: ${Object.keys(rules).join(', ') || 'none'})`,
    );
  }

  // Single-rule module: the default export, or the namespace itself.
  const candidate = mod.default ?? mod;
  if (isEslintRule(candidate)) return candidate;
  if (isEslintRule(mod)) return mod;
  throw new Error('module does not export an ESLint rule or a plugin `rules` map');
}

/** Derive the rule key from a rule id's last path segment (`@scope/foo` → `foo`). */
function deriveRuleName(ruleId: string): string {
  const segments = ruleId.split('/');
  return segments[segments.length - 1] ?? ruleId;
}

/** Whether `value` is a usable ESLint rule: an object with a `create` function, or a
 *  legacy function-style rule. */
function isEslintRule(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { create?: unknown }).create === 'function';
}

// ---------------------------------------------------------------------------
// RuleTester construction + per-case execution
// ---------------------------------------------------------------------------

/** Construct a RuleTester, trying the ESLint 9 flat-config shape first and falling
 *  back to the ESLint 8 legacy shape, then a no-arg construction. Also installs
 *  synchronous run hooks so `.run` never defers to (or is hijacked by) an ambient
 *  test framework and its assertion errors surface synchronously to our try/catch. */
function makeRuleTester(RuleTester: RuleTesterCtor): RuleTesterInstance {
  installSyncHooks(RuleTester);
  const flat = { languageOptions: { ecmaVersion: 2022, sourceType: 'module' } };
  const legacy = { parserOptions: { ecmaVersion: 2022, sourceType: 'module' } };
  for (const config of [flat, legacy, undefined]) {
    try {
      return new RuleTester(config);
    } catch {
      // Try the next config shape (version differences in the accepted schema).
    }
  }
  // Re-throw the flat-shape error for the caller's structured report.
  return new RuleTester(flat);
}

/** Force RuleTester's static `describe`/`it` hooks to run synchronously and let
 *  thrown assertions propagate, so behavior is deterministic regardless of whether a
 *  test framework's globals happen to be present in the process. */
function installSyncHooks(RuleTester: RuleTesterCtor): void {
  const run: RuleTesterHook = (_text, fn) => {
    fn();
  };
  RuleTester.describe = run;
  RuleTester.it = run;
  RuleTester.itOnly = run;
}

interface CaseRun {
  passed: boolean;
  message?: string;
}

/** Run a single case (valid or invalid) in its own RuleTester call, capturing the
 *  assertion message on failure instead of letting it throw out. */
function runCase(
  tester: RuleTesterInstance,
  ruleId: string,
  rule: unknown,
  kind: 'valid' | 'invalid',
  testCase: unknown,
): CaseRun {
  const suites: RuleTesterSuites =
    kind === 'valid'
      ? { valid: [testCase], invalid: [] }
      : { valid: [], invalid: [testCase] };
  try {
    tester.run(ruleId, rule, suites);
    return { passed: true };
  } catch (error) {
    return { passed: false, message: describeError(error) };
  }
}

/** Spread helper: only attach a `message` key when the case failed. */
function messageOf(result: CaseRun): { message?: string } {
  return result.message !== undefined ? { message: result.message } : {};
}

/** Parse a `valid` case: raw source, or a JSON case object (`{ code, options, ... }`).
 *  A non-JSON string is the source code itself (the common case). */
function parseValidCase(raw: string): unknown {
  return asCaseOrCode(raw);
}

/** Parse an `invalid` case: a JSON `{ code, errors, output? }`. A bare string is
 *  treated as `code` expecting at least one reported error, so a caller can pass raw
 *  offending source without hand-writing the `errors` count. */
function parseInvalidCase(raw: string): unknown {
  const parsed = asCaseOrCode(raw);
  if (typeof parsed === 'string') {
    return { code: parsed, errors: 1 };
  }
  return parsed;
}

/** JSON-parse a case string; a `string`/`object` result is used as-is, anything else
 *  (or a parse failure) means the raw string is the source code. */
function asCaseOrCode(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed === 'object' && parsed !== null) return parsed;
    return raw;
  } catch {
    return raw;
  }
}

/** A short, safe message for any thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
