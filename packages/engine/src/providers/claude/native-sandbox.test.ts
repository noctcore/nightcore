/// <reference types="bun" />
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  evaluateWorkspaceConfinement,
  WORKSPACE_CONFINEMENT_RULE_ID,
} from '../../policy/workspace-confinement.js';
import {
  buildSandboxSettings,
  CREDENTIAL_DENY_ENV_VARS,
  CREDENTIAL_MASK_PREREQUISITES,
  credentialDenyFiles,
  gitCommonWriteRoots,
  nativeSandboxAvailability,
  resolveNativeContainment,
  sandboxWritableRoots,
  unsupportedPlatformReason,
} from './native-sandbox.js';

/** Whether the REAL OS-enforcement test can run here. The native sandbox is a
 *  macOS Seatbelt profile under the hood, so the enforcement proof is darwin-only
 *  by nature; on other hosts it skips (and the macOS CI lane exists precisely so
 *  it is not skipped everywhere — see .github/workflows/ci.yml `macos-sandbox`). */
const canSandbox =
  process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gitCommonWriteRoots — the one derivation we keep owning
// ---------------------------------------------------------------------------

describe('gitCommonWriteRoots', () => {
  test('non-repo cwd ⇒ no roots', () => {
    expect(gitCommonWriteRoots(makeTempDir('nc-native-sb-'))).toEqual([]);
  });

  test('normal checkout (.git is a directory) ⇒ no roots (already under cwd)', () => {
    const cwd = makeTempDir('nc-native-sb-');
    fs.mkdirSync(path.join(cwd, '.git'));
    expect(gitCommonWriteRoots(cwd)).toEqual([]);
  });

  test('linked worktree ⇒ the parent repo .git common dir (never its working tree)', () => {
    const repo = makeTempDir('nc-native-sb-');
    const gitdir = path.join(repo, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(gitdir, { recursive: true });
    const cwd = makeTempDir('nc-native-sb-');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${gitdir}\n`);

    const roots = gitCommonWriteRoots(cwd);
    expect(roots).toEqual([fs.realpathSync(path.join(repo, '.git'))]);
    // The parent WORKING TREE stays unwritable — the 2026-07-01 escape incident.
    expect(roots).not.toContain(fs.realpathSync(repo));
  });

  test('gitdir outside a worktrees layout ⇒ the pointed-to dir itself', () => {
    const target = makeTempDir('nc-native-sb-');
    const cwd = makeTempDir('nc-native-sb-');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${target}\n`);
    expect(gitCommonWriteRoots(cwd)).toEqual([fs.realpathSync(target)]);
  });
});

// ---------------------------------------------------------------------------
// sandboxWritableRoots
// ---------------------------------------------------------------------------

describe('sandboxWritableRoots', () => {
  test('cwd is writable and canonicalized', () => {
    const cwd = makeTempDir('nc-native-sb-');
    expect(sandboxWritableRoots({ cwd })).toEqual([fs.realpathSync(cwd)]);
  });

  test('deduplicates a project root that canonicalizes to cwd', () => {
    const cwd = makeTempDir('nc-native-sb-');
    expect(sandboxWritableRoots({ cwd, projectRoot: cwd })).toHaveLength(1);
  });

  test('a differing project root is included alongside cwd', () => {
    const cwd = makeTempDir('nc-native-sb-');
    const projectRoot = makeTempDir('nc-native-sb-');
    const roots = sandboxWritableRoots({ cwd, projectRoot });
    expect(roots).toContain(fs.realpathSync(cwd));
    expect(roots).toContain(fs.realpathSync(projectRoot));
  });

  test('worktree cwd pulls in the parent repo git common dir', () => {
    const repo = makeTempDir('nc-native-sb-');
    const gitdir = path.join(repo, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(gitdir, { recursive: true });
    const cwd = makeTempDir('nc-native-sb-');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${gitdir}\n`);
    expect(sandboxWritableRoots({ cwd })).toContain(
      fs.realpathSync(path.join(repo, '.git')),
    );
  });

  test('the home dir is NEVER a writable root', () => {
    const roots = sandboxWritableRoots({ cwd: makeTempDir('nc-native-sb-') });
    expect(roots).not.toContain(os.homedir());
    expect(roots).not.toContain(path.join(os.homedir(), '.claude'));
  });
});

// ---------------------------------------------------------------------------
// buildSandboxSettings — the policy handed to the SDK
// ---------------------------------------------------------------------------

describe('buildSandboxSettings', () => {
  test('enables the sandbox and REFUSES the model an unsandboxed escape hatch', () => {
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.enabled).toBe(true);
    // Under `bypassPermissions` a `dangerouslyDisableSandbox` retry would be
    // auto-approved and would defeat the whole boundary — this must stay false.
    expect(settings.allowUnsandboxedCommands).toBe(false);
  });

  test('failIfUnavailable is explicitly false (D3 phase 1) — the SDK would default it true', () => {
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.failIfUnavailable).toBe(false);
  });

  test('allowWrite is exactly the derived roots — cwd in, home out', () => {
    const cwd = makeTempDir('nc-native-sb-');
    const settings = buildSandboxSettings({ cwd });
    expect(settings.filesystem?.allowWrite).toEqual(sandboxWritableRoots({ cwd }));
    expect(settings.filesystem?.allowWrite).not.toContain(os.homedir());
  });

  test('no network config — this is write containment, exactly like the writer it replaces', () => {
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.network).toBeUndefined();
  });

  test('no excludedCommands — nothing is punched OUT of the sandbox by default', () => {
    // Pre-seeding `gh`/`docker` exclusions would run those commands unsandboxed;
    // the Go-TLS breakage that motivates them only exists with a MITM proxy CA,
    // which this configuration never sets up.
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.excludedCommands).toBeUndefined();
  });

  test('never weakens isolation: no Apple Events, no weaker nested/network sandbox', () => {
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.allowAppleEvents).toBeUndefined();
    expect(settings.enableWeakerNestedSandbox).toBeUndefined();
    expect(settings.enableWeakerNetworkIsolation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// credentials — the `sandbox.credentials` mask/deny wiring
// ---------------------------------------------------------------------------

describe('sandbox.credentials', () => {
  test('denies exactly the recorded env-var set, every entry mode `deny`', () => {
    // Pinned: widening this list is a policy change, not a refactor.
    expect([...CREDENTIAL_DENY_ENV_VARS]).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]);
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.credentials?.envVars?.map((e) => e.name)).toEqual([
      ...CREDENTIAL_DENY_ENV_VARS,
    ]);
    expect(settings.credentials?.envVars?.every((e) => e.mode === 'deny')).toBe(true);
  });

  test('the ANTHROPIC key is denied to sandboxed commands — the capability the old writer never had', () => {
    // `subprocess-env.ts` deliberately PASSES `ANTHROPIC_*` to the CLI (it needs
    // its own auth); this is the only layer that keeps it out of an agent shell.
    expect([...CREDENTIAL_DENY_ENV_VARS]).toContain('ANTHROPIC_API_KEY');
  });

  test('denies reads of the recorded home credential stores, absolute + mode `deny`', () => {
    const home = os.homedir();
    expect(credentialDenyFiles()).toEqual([
      path.join(home, '.aws'),
      path.join(home, '.ssh'),
      path.join(home, '.gnupg'),
    ]);
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    expect(settings.credentials?.files?.map((f) => f.path)).toEqual(credentialDenyFiles());
    expect(settings.credentials?.files?.every((f) => f.mode === 'deny')).toBe(true);
    expect(settings.credentials?.files?.every((f) => path.isAbsolute(f.path))).toBe(true);
  });

  test('`mask` is NOT emitted at the pinned SDK, and its prerequisites are recorded', () => {
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    const modes = [
      ...(settings.credentials?.envVars ?? []).map((e) => e.mode),
      ...(settings.credentials?.files ?? []).map((f) => f.mode),
    ];
    expect(modes.every((m) => m === 'deny')).toBe(true);
    // The parked half of the credentials item is written down, not folklore.
    expect(CREDENTIAL_MASK_PREREQUISITES).toHaveLength(3);
    expect(CREDENTIAL_MASK_PREREQUISITES.join(' ')).toContain('v2.1.199');
  });

  test('the credential lists never leak a value — only names and paths', () => {
    const settings = buildSandboxSettings({ cwd: makeTempDir('nc-native-sb-') });
    const serialized = JSON.stringify(settings.credentials);
    for (const name of CREDENTIAL_DENY_ENV_VARS) {
      const value = process.env[name];
      if (value !== undefined && value !== '') {
        expect(serialized).not.toContain(value);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// availability + the loud-unavailability posture
// ---------------------------------------------------------------------------

describe('nativeSandboxAvailability', () => {
  test.skipIf(!canSandbox)('darwin with Seatbelt ⇒ available, no reason', () => {
    expect(nativeSandboxAvailability()).toEqual({ available: true });
  });

  test.skipIf(canSandbox)('non-darwin ⇒ unavailable WITH a reason naming the platform', () => {
    const availability = nativeSandboxAvailability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeString();
    expect(availability.reason).toContain(process.platform);
  });

  test('the unsupported-platform reason names macOS and the host', () => {
    expect(unsupportedPlatformReason('linux')).toContain('macOS');
    expect(unsupportedPlatformReason('linux')).toContain('linux');
  });
});

describe('resolveNativeContainment', () => {
  test('not requested ⇒ inert: no settings, no reason, no warning', () => {
    const warnings: unknown[] = [];
    const decision = resolveNativeContainment({
      requested: false,
      cwd: makeTempDir('nc-native-sb-'),
      logger: { warn: (...args: unknown[]) => warnings.push(args) } as never,
    });
    expect(decision).toEqual({ requested: false, active: false });
    expect(warnings).toHaveLength(0);
  });

  test.skipIf(!canSandbox)('requested on a supported host ⇒ active WITH settings', () => {
    const cwd = makeTempDir('nc-native-sb-');
    const decision = resolveNativeContainment({ requested: true, cwd });
    expect(decision.requested).toBe(true);
    expect(decision.active).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.settings?.enabled).toBe(true);
  });

  test.skipIf(canSandbox)(
    'requested but unavailable ⇒ LOUD: warns, carries a reason, and emits NO settings',
    () => {
      const warnings: string[] = [];
      const decision = resolveNativeContainment({
        requested: true,
        cwd: makeTempDir('nc-native-sb-'),
        logger: { warn: (message: string) => warnings.push(message) } as never,
      });
      // Never silently degrade: the caller gets an explicit inactive posture with
      // a human reason, and the log line says the run is gate-only.
      expect(decision).toMatchObject({ requested: true, active: false });
      expect(decision.reason).toBeString();
      expect(decision.settings).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('OS WRITE CONTAINMENT UNAVAILABLE');
    },
  );
});

// ---------------------------------------------------------------------------
// REAL OS ENFORCEMENT PROOF (darwin-only; the macOS CI lane runs it)
// ---------------------------------------------------------------------------

describe('OS enforcement (integration, real Seatbelt)', () => {
  /**
   * Compile the `allowWrite` policy this module produces into the equivalent
   * Seatbelt profile and EXECUTE a forbidden write under it.
   *
   * Why this test exists in this shape: after the migration the ENFORCER is the
   * SDK's bundled sandbox-runtime, which cannot be driven from a unit test
   * without a live, credentialed `claude` session. What Nightcore still owns —
   * and what a regression would actually break — is the `allowWrite` SET. So the
   * proof runs that exact set through the same OS primitive the native sandbox
   * uses on macOS (Seatbelt `file-write*` deny-except-subpath) and requires a
   * write outside it to be REFUSED. A profile derived from a widened root set
   * (e.g. one that let `$HOME` back in) fails here.
   *
   * It is deliberately NOT a mock: `spawnSync` really runs, the write really is
   * attempted, and the assertion is on the exit status AND on the file's absence.
   */
  function seatbeltProfileFor(allowWrite: readonly string[]): string {
    const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
    for (const root of allowWrite) {
      lines.push(`(allow file-write* (subpath "${root.replace(/(["\\])/g, '\\$1')}"))`);
    }
    return lines.join('\n') + '\n';
  }

  function runSandboxed(profilePath: string, cmd: string) {
    return spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', cmd], {
      timeout: 15_000,
    });
  }

  test.skipIf(!canSandbox)(
    'a Bash redirect OUTSIDE the derived allowWrite roots is DENIED by the OS',
    () => {
      const cwd = fs.realpathSync(makeTempDir('nc-native-sb-cwd-'));
      const outside = fs.realpathSync(makeTempDir('nc-native-sb-out-'));
      const scratch = makeTempDir('nc-native-sb-profile-');
      const allowWrite = buildSandboxSettings({ cwd }).filesystem?.allowWrite ?? [];
      // Sanity: the policy under test must actually be the cwd-only policy.
      expect(allowWrite).toEqual([cwd]);

      const profilePath = path.join(scratch, 'derived.sb');
      fs.writeFileSync(profilePath, seatbeltProfileFor(allowWrite));

      // The agent's own workspace stays writable — containment must not break the job.
      const allowed = runSandboxed(profilePath, `echo ok > "${cwd}/in-workspace.txt"`);
      expect(allowed.status).toBe(0);
      expect(fs.readFileSync(path.join(cwd, 'in-workspace.txt'), 'utf8')).toBe('ok\n');

      // The forbidden operation: the exact Bash-redirect vector the lexical
      // PreToolUse gate documents as a residual gap. It MUST be refused.
      const denied = runSandboxed(profilePath, `echo pwned > "${outside}/escaped.txt"`);
      expect(denied.status).not.toBe(0);
      expect(fs.existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
    },
  );

  test.skipIf(!canSandbox)(
    'a write to $HOME is DENIED — the home dir is outside every derived root',
    () => {
      const cwd = fs.realpathSync(makeTempDir('nc-native-sb-cwd-'));
      const scratch = makeTempDir('nc-native-sb-profile-');
      const profilePath = path.join(scratch, 'derived.sb');
      fs.writeFileSync(
        profilePath,
        seatbeltProfileFor(buildSandboxSettings({ cwd }).filesystem?.allowWrite ?? []),
      );

      const probe = path.join(os.homedir(), '.nightcore-native-sandbox-probe');
      const denied = runSandboxed(profilePath, `echo pwned > "${probe}"`);
      // Capture-then-clean BEFORE asserting so a containment regression cannot
      // leave a stray file in the developer's home directory.
      const leaked = fs.existsSync(probe);
      fs.rmSync(probe, { force: true });
      expect(denied.status).not.toBe(0);
      expect(leaked).toBe(false);
    },
  );

  test.skipIf(!canSandbox)(
    'a worktree session can write its parent .git common dir but NOT the parent working tree',
    () => {
      const repo = fs.realpathSync(makeTempDir('nc-native-sb-repo-'));
      const gitdir = path.join(repo, '.git', 'worktrees', 'wt1');
      fs.mkdirSync(gitdir, { recursive: true });
      const cwd = fs.realpathSync(makeTempDir('nc-native-sb-wt-'));
      fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${gitdir}\n`);
      const scratch = makeTempDir('nc-native-sb-profile-');
      const profilePath = path.join(scratch, 'derived.sb');
      fs.writeFileSync(
        profilePath,
        seatbeltProfileFor(buildSandboxSettings({ cwd }).filesystem?.allowWrite ?? []),
      );

      // git needs the common dir (index/locks/objects/refs) — allowed.
      const gitWrite = runSandboxed(profilePath, `echo lock > "${repo}/.git/index.lock"`);
      expect(gitWrite.status).toBe(0);

      // The parent CHECKOUT is the 2026-07-01 escape — denied.
      const escape = runSandboxed(profilePath, `echo pwned > "${repo}/src.txt"`);
      expect(escape.status).not.toBe(0);
      expect(fs.existsSync(path.join(repo, 'src.txt'))).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// The two-layer invariant: the native sandbox does NOT replace the PreToolUse gate
// ---------------------------------------------------------------------------

describe('native sandbox + PreToolUse gate are disjoint layers', () => {
  // "The sandbox isolates Bash subprocesses. Other tools operate under different
  // boundaries: Built-in file tools: Read, Edit, and Write use the permission
  // system directly rather than running through the sandbox" (SDK docs, Scope).
  // Nightcore's real 2026-07-01 escape was a `Write` to the parent repo — a native
  // tool call the OS sandbox never sees. T12 §6's invariant: KEEP the gate.
  const WORKTREE = '/repo/.nightcore/worktrees/task-1';
  const MAIN = '/repo';

  test('the sandbox settings claim nothing about the native file tools', () => {
    const settings = buildSandboxSettings({ cwd: WORKTREE });
    // The only tool-scoping knob this schema has is `excludedCommands`, which is
    // about Bash commands. Nothing here can confine Write/Edit/NotebookEdit —
    // which is exactly why the gate stays.
    expect(Object.keys(settings)).not.toContain('tools');
    expect(settings.excludedCommands).toBeUndefined();
  });

  test.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])(
    'the gate still DENIES %s escaping the workspace with the sandbox armed',
    (tool) => {
      // Runs the REAL gate, not a stub: a forbidden operation is attempted and
      // must come back denied. The rule-id assertion keeps it from passing for the
      // wrong reason (e.g. an empty cwd disabling the gate returns no rule id).
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      const verdict = evaluateWorkspaceConfinement(
        tool,
        { [key]: `${MAIN}/apps/web/src/escaped.ts` },
        WORKTREE,
      );
      expect(verdict.denied).toBe(true);
      expect(verdict.ruleId).toBe(WORKSPACE_CONFINEMENT_RULE_ID);
    },
  );

  test('the gate DENIES an ApplyPatch into the parent checkout the sandbox never inspects', () => {
    const verdict = evaluateWorkspaceConfinement(
      'ApplyPatch',
      {
        patch: `*** Begin Patch\n*** Update File: ${MAIN}/apps/web/src/escaped.ts\n*** End Patch`,
      },
      WORKTREE,
    );
    expect(verdict.denied).toBe(true);
  });
});
