/**
 * OS-level WRITE containment for agent sessions via the Claude Agent SDK's
 * **native sandbox** (`Options.sandbox`) — the replacement for Nightcore's
 * hand-rolled Seatbelt profile writer (T16 / issue #157).
 *
 * ## What decision this implements, and where it is recorded
 *
 * **D4 (adopt vs keep) — ADOPT (hybrid).** Recorded by the user on issue #153
 * ("Native sandbox vs sandbox.ts — ADOPT (hybrid): replace `sandbox.ts` with the
 * SDK's `Options.sandbox`, keep the PreToolUse gate (disjoint coverage). This is
 * a GO for T16 (#157), scoped to sandbox.ts only."), from the spike memo
 * `docs/research/2026-07-12-platform-primitives-spike.md` §1/§6/§7-D4. The old
 * writer generated a TinyScheme profile + an exec wrapper shim and probed
 * `/usr/bin/sandbox-exec`; all of that is now the SDK's job, and this module only
 * *derives the policy* it hands over.
 *
 * **The PreToolUse gate is NOT replaced** (memo §1 reason 3, §6 invariant): the
 * native sandbox isolates **Bash subprocesses only** — `Read`/`Edit`/`Write`/
 * `NotebookEdit`/`ApplyPatch`/`mcp__*` run through the permission system, never
 * through the sandbox. Nightcore's real worktree-escape incident (2026-07-01) was
 * a `Write` to the parent repo, which the OS sandbox would never have seen. The
 * two layers are complementary and both must exist.
 *
 * **D3 (default staging) — staged default-on.** Answered by the user
 * 2026-07-12: *macOS + worktree-mode first, per-run opt-out, `failIfUnavailable:
 * false` + a loud "containment unavailable" surface, widen to main-mode once
 * telemetry is clean* — with a same-minute amendment that **Linux is out of
 * project scope for now**, which deletes the memo's "widen to Linux" phase. The
 * staging RESOLUTION (who gets it on by default) lives in the Rust core
 * (`store::settings::Settings::sandbox_writes_for`); this module owns only the
 * two engine-side halves: (a) is native containment available on this host, and
 * (b) what policy do we hand the SDK.
 *
 * ## Fail posture — degrade LOUDLY, never silently
 *
 * `failIfUnavailable` is emitted as `false` per D3 phase 1, so an SDK/CLI that
 * cannot start its sandbox does not strand the run. That alone would be a SILENT
 * degrade, so Nightcore does its own preflight ({@link nativeSandboxAvailability})
 * and, when containment was requested but cannot be provided, reports it:
 *   - a WARN log,
 *   - a flight-recorder marker (`event: 'containment'`) in the per-task ledger —
 *     the local telemetry D3 asks for before widening,
 *   - and `containment` on the `session-started` event, which the board renders
 *     as a visible "containment unavailable" badge.
 * The run continues under the PreToolUse gate alone; it is never quiet about it.
 *
 * ## Platform scope (staging phase 1)
 *
 * macOS only. The native sandbox itself also supports Linux/WSL2 via bubblewrap,
 * but Linux is explicitly out of project scope (user directive, 2026-07-12), so
 * this module reports every non-darwin host as UNAVAILABLE rather than claiming a
 * containment guarantee nobody has verified for this app. That is a strict
 * improvement on the old writer, which was also macOS-only but said nothing.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '@nightcore/shared';

import type { SandboxSettings } from './sdk-adapter.js';

/** The Seatbelt interpreter macOS containment rests on. Its presence is the
 *  concrete evidence the availability probe checks — an absolute, SIP-protected
 *  path, never resolved through `PATH`. */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Why native containment is unavailable on a non-darwin host. Phase 1 of the
 *  D3 staging is macOS-only and Linux is out of project scope, so this is a
 *  deliberate refusal to claim a guarantee, not a capability gap report. */
export function unsupportedPlatformReason(platform: string): string {
  return (
    `native OS containment is verified for macOS only in this staging phase ` +
    `(host is ${platform})`
  );
}

/** The result of the host preflight: whether the SDK's native sandbox can
 *  contain this session, and — when it cannot — a short human reason safe to log
 *  and to render in the UI. */
export interface NativeSandboxAvailability {
  available: boolean;
  reason?: string;
}

let availabilityCache: NativeSandboxAvailability | undefined;

/**
 * Preflight: can this host provide native OS containment? macOS with a present
 * `/usr/bin/sandbox-exec` ⇒ yes; anything else ⇒ no, with a reason. Memoized —
 * the answer cannot change mid-process.
 *
 * Deliberately does NOT execute anything: the old writer smoke-ran `sandbox-exec`
 * because IT was the enforcer, whereas here the SDK owns enforcement and a probe
 * spawn would only prove a binary we no longer invoke still runs.
 */
export function nativeSandboxAvailability(): NativeSandboxAvailability {
  if (availabilityCache !== undefined) return availabilityCache;
  availabilityCache = probeNativeSandbox();
  return availabilityCache;
}

/** Clear the memoized preflight; for tests that fake the platform/filesystem. */
export function resetNativeSandboxAvailabilityCacheForTest(): void {
  availabilityCache = undefined;
}

function probeNativeSandbox(): NativeSandboxAvailability {
  if (process.platform !== 'darwin') {
    return { available: false, reason: unsupportedPlatformReason(process.platform) };
  }
  if (!fs.existsSync(SANDBOX_EXEC)) {
    return {
      available: false,
      reason: `macOS Seatbelt is missing (${SANDBOX_EXEC} not found)`,
    };
  }
  return { available: true };
}

/** `fs.realpathSync` that degrades to the resolved absolute input when the target
 *  doesn't exist — a not-yet-created root still gets an allow rule so the agent
 *  can CREATE it. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * When `cwd` is a LINKED git worktree, its `.git` is a FILE containing
 * `gitdir: <abs>/.git/worktrees/<name>`. Git operations inside the worktree write
 * to that common dir (index, locks, objects, refs), so containment must allow the
 * whole `<abs>/.git` — otherwise every `git` command in a worktree session fails.
 * Returns `[]` for a normal checkout (its `.git` DIRECTORY is already under cwd)
 * or a non-repo cwd. The parent WORKING TREE is deliberately NOT allowed: an agent
 * in a worktree writing to the main checkout is the observed incident this feature
 * exists to stop.
 *
 * The native sandbox documents the same worktree handling upstream, but it is
 * derived here too and passed explicitly: an `allowWrite` we compute is auditable
 * and testable, where an implicit upstream behavior is neither.
 */
export function gitCommonWriteRoots(cwd: string): string[] {
  const dotGit = path.join(cwd, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  let content: string;
  try {
    content = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return [];
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
  if (!match || match[1] === undefined) return [];
  const gitdir = path.resolve(cwd, match[1].trim());
  // `<repo>/.git/worktrees/<name>` → allow `<repo>/.git`. Any other layout
  // (bare/odd setups) → allow the pointed-to dir itself.
  const worktreesDir = path.dirname(gitdir);
  const commonDir =
    path.basename(worktreesDir) === 'worktrees' ? path.dirname(worktreesDir) : gitdir;
  return [realpathOr(commonDir)];
}

/**
 * The `filesystem.allowWrite` set for one session: the session cwd (+ the project
 * root when the caller knows it and it differs) and the git common dir for a
 * worktree cwd. Canonicalized, deduplicated, order-stable.
 *
 * NOT included, deliberately: `/dev`, the temp trees, and the Claude CLI's own
 * state/cache dirs — the native sandbox grants the session's temp dir and its own
 * config/state needs itself, and re-granting them here would only widen the
 * boundary with paths we no longer have to maintain. Notably the old writer had to
 * carve `~/.claude/settings.json` back OUT of a writable `~/.claude`; the native
 * sandbox "automatically denies write access to Claude Code's `settings.json`
 * files at every scope" (SDK docs, Security limitations), so that whole
 * hook-injection carve-out is now upstream's invariant rather than ours.
 */
export function sandboxWritableRoots(opts: {
  cwd: string;
  projectRoot?: string;
}): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    const real = realpathOr(p);
    if (!seen.has(real)) {
      seen.add(real);
      roots.push(real);
    }
  };
  add(opts.cwd);
  if (opts.projectRoot !== undefined) add(opts.projectRoot);
  for (const gitRoot of gitCommonWriteRoots(opts.cwd)) add(gitRoot);
  return roots;
}

/**
 * Environment variables UNSET for sandboxed Bash commands (`credentials.envVars`,
 * mode `deny`) — the "secrets never enter the agent's shell" capability the custom
 * writer never had (memo §3/§6 step 5: "unset `GITHUB_TOKEN`/AWS/`ANTHROPIC_*`
 * from sandboxed Bash").
 *
 * Two different jobs, both load-bearing:
 *  - `AWS_*` / `GITHUB_TOKEN` / `GH_TOKEN` are ALREADY dropped before the CLI
 *    starts by the `subprocess-env.ts` allowlist, so denying them here is
 *    defense-in-depth that stays correct if that allowlist is ever widened.
 *  - `ANTHROPIC_*` is the one the allowlist deliberately PASSES THROUGH (the CLI
 *    needs its own credentials). Denying it here removes it from **sandboxed
 *    commands only** — the CLI process keeps its auth, while `env`/`printenv` in
 *    an agent shell can no longer read the key. That is the new capability.
 *
 * Exactly the set the recorded decision names — deliberately not widened here.
 * Adding a name is a policy change and belongs in a decision record first.
 */
export const CREDENTIAL_DENY_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

/** Home-relative credential STORES denied for reads inside the sandbox
 *  (`credentials.files`, mode `deny`) — the portable, high-value key material a
 *  prompt-injected task would exfiltrate. Exactly the set the recorded decision
 *  names (memo §3: "block `~/.aws`/`~/.ssh` reads"; §6 step 2: "`files: [deny
 *  ~/.aws, ~/.ssh, ~/.gnupg…]`") and a subset of the PreToolUse gate's own
 *  `sensitive-read` denylist, so this extends an ALREADY-ENFORCED policy from the
 *  `Read` tool to Bash subprocesses rather than inventing a new one.
 *
 *  KNOWN CONSEQUENCE (accepted, and the reason the opt-out exists): a sandboxed
 *  `git push`/`fetch` over SSH cannot read `~/.ssh` and will fail. Nightcore's own
 *  git operations run in the Rust core, OUTSIDE the sandbox, so the commit / merge
 *  / PR paths are unaffected — only an agent shelling out to git-over-SSH itself
 *  is. Same class as the GitKraken-hook breakage the old writer documented:
 *  unexpected credential readers are exactly what containment blocks. */
const CREDENTIAL_DENY_HOME_RELATIVE: readonly string[] = ['.aws', '.ssh', '.gnupg'] as const;

/** The absolute credential-store paths denied for reads inside the sandbox. */
export function credentialDenyFiles(): string[] {
  const home = os.homedir();
  return CREDENTIAL_DENY_HOME_RELATIVE.map((rel) => path.join(home, rel));
}

/**
 * The `Options.sandbox` block for one session.
 *
 * Knob rationale (each verified against the pinned SDK schema,
 * `@anthropic-ai/claude-agent-sdk@0.3.190`, `sdk.d.ts` `SandboxSettingsSchema`):
 *  - `enabled: true` — turn OS containment on for this session's Bash tool.
 *  - `failIfUnavailable: false` — D3 phase 1. The SDK DEFAULTS this to `true`
 *    when `enabled` is true, which would strand a run on any host that can't
 *    sandbox; the flip to fail-closed is phase 3 ("main-mode + fail-closed once
 *    proven"). Nightcore's own preflight + loud surface is what keeps `false`
 *    from meaning "silently unconfined".
 *  - `allowUnsandboxedCommands: false` — STRICT. Nightcore runs under
 *    `bypassPermissions`, where the model's `dangerouslyDisableSandbox` escape
 *    hatch would be auto-approved and would silently defeat the whole boundary.
 *  - `filesystem.allowWrite` — {@link sandboxWritableRoots}.
 *  - `credentials` — {@link CREDENTIAL_DENY_ENV_VARS} / {@link credentialDenyFiles}.
 *
 * NOT set, deliberately:
 *  - `network.*` — write containment only, exactly as the custom writer was.
 *    Network egress control is a separable later toggle (memo §6 step 6), and
 *    turning it on here would fight the unattended flow on first run.
 *  - `excludedCommands` — the memo flags `gh`/`gcloud`/`docker` as needing an
 *    exclusion under Seatbelt, but that failure mode is specifically about
 *    Go-TLS verification against a MITM proxy CA, which only exists when
 *    `network.httpProxyPort` + `tlsTerminate` are configured. We configure
 *    neither, so pre-seeding exclusions would punch commands OUT of the sandbox
 *    for a problem this configuration cannot have.
 *  - `credentials.envVars[].mode: 'mask'` — NOT available at the pinned SDK: the
 *    schema literal is `z.ZodLiteral<"deny">` for both arrays and the SDK's own
 *    comment says to "widen the mode (e.g. `mask`) only once a sandbox-runtime
 *    version that enforces it ships". See {@link CREDENTIAL_MASK_PREREQUISITES}.
 */
export function buildSandboxSettings(opts: {
  cwd: string;
  projectRoot?: string;
}): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: false,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: sandboxWritableRoots(opts) },
    credentials: {
      envVars: CREDENTIAL_DENY_ENV_VARS.map((name) => ({ name, mode: 'deny' as const })),
      files: credentialDenyFiles().map((p) => ({ path: p, mode: 'deny' as const })),
    },
  };
}

/**
 * The three conditions that must ALL hold before `credentials … mode: 'mask'`
 * (+ `injectHosts`) can replace `deny` — the parked half of the T16 credentials
 * item, recorded so the next attempt re-verifies rather than assumes.
 *
 * The masked mode keeps `gh`/`npm` working while the agent only ever sees a
 * per-session sentinel, which is strictly better than unsetting the variable —
 * but shipping it against the pinned SDK would emit a mode the schema rejects and
 * that sandbox-runtime silently ignores, i.e. a credential guarantee that isn't
 * enforced. That is worse than `deny`, not better.
 */
export const CREDENTIAL_MASK_PREREQUISITES: readonly string[] = [
  'the SDK `SandboxCredentialsConfig` schema widens past the `deny` literal',
  'the user-installed Claude Code CLI is >= v2.1.199',
  '`sandbox.network.tlsTerminate` is wired (mask needs the TLS-terminating proxy)',
] as const;

/** The containment posture of one session — the value the runner logs, records in
 *  the flight recorder, and the manager echoes onto `session-started`. */
export interface NativeContainment {
  /** The run asked for OS containment (settings/per-task resolution said yes). */
  requested: boolean;
  /** OS containment is actually being applied to this session's Bash tool. */
  active: boolean;
  /** Why containment is not active although it was requested. Present ONLY in the
   *  requested-but-unavailable case — this is the "loud unavailability" string. */
  reason?: string;
  /** The `Options.sandbox` block to hand the SDK. Present iff `active`. */
  settings?: SandboxSettings;
}

/**
 * Resolve the containment posture for one session: not requested ⇒ inert;
 * requested and available ⇒ active with settings; requested and unavailable ⇒
 * INACTIVE WITH A REASON (never a silent pass-through), after a WARN.
 */
export function resolveNativeContainment(opts: {
  requested: boolean;
  cwd: string;
  projectRoot?: string;
  logger?: Logger;
}): NativeContainment {
  if (!opts.requested) return { requested: false, active: false };
  const availability = nativeSandboxAvailability();
  if (!availability.available) {
    const reason = availability.reason ?? 'native OS containment is unavailable on this host';
    opts.logger?.warn(
      'OS WRITE CONTAINMENT UNAVAILABLE: this session requested OS-level write ' +
        'containment but this host cannot provide it. The session runs with the ' +
        'PreToolUse policy gate ONLY (no OS-level enforcement of Bash writes).',
      { reason, platform: process.platform },
    );
    return { requested: true, active: false, reason };
  }
  return {
    requested: true,
    active: true,
    settings: buildSandboxSettings({
      cwd: opts.cwd,
      ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    }),
  };
}

/** The subset of `SessionLedger` this module needs — structural so `native-sandbox`
 *  does not depend on the recorder's construction/lifecycle. */
export interface ContainmentRecorder {
  recordContainment(sessionId: number, posture: { active: boolean; reason?: string }): void;
}

/**
 * Announce a resolved posture at launch: an INFO line naming the writable roots
 * when containment applies, plus one flight-recorder `containment` marker for any
 * session that ASKED for it — the local telemetry D3 requires before the default
 * is widened ("widen to main-mode once telemetry is clean").
 *
 * A session that never requested containment records nothing, so the ledger file
 * stays byte-identical for every pre-feature/scan run. The unavailable case was
 * already WARNed by {@link resolveNativeContainment}; this adds the durable half.
 */
export function announceNativeContainment(
  containment: NativeContainment,
  sessionId: number,
  logger?: Logger,
  ledger?: ContainmentRecorder,
): void {
  if (!containment.requested) return;
  if (containment.active) {
    logger?.info('OS write containment active (native sandbox)', {
      allowWrite: containment.settings?.filesystem?.allowWrite ?? [],
    });
  }
  ledger?.recordContainment(sessionId, {
    active: containment.active,
    ...(containment.reason !== undefined ? { reason: containment.reason } : {}),
  });
}
