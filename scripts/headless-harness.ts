#!/usr/bin/env bun
/**
 * Headless engine harness — drives the REAL sidecar (apps/sidecar) over its
 * NDJSON stdio protocol, exactly as the Rust core does, against a scratch repo.
 * Validates the live SDK path end-to-end: build session + native tools + the
 * maxTurns guardrail + session resume. Uses real Claude (subscription auth via
 * ~/.claude). Not a committed test — a dogfood probe.
 */
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { NightcoreEvent, SurfaceCommand } from '@nightcore/contracts';

/**
 * Config (all overridable so this is portable, not pinned to one machine):
 *   - REPO    : repo root, derived from this script's location.
 *   - SCRATCH : the throwaway git repo to run the probe against. First CLI arg,
 *               else $HARNESS_SCRATCH, else a sibling `test-repo`. It WILL be
 *               mutated (a file is written), so point it at something safe.
 *   - MODEL   : $HARNESS_MODEL, else sonnet (cheaper than opus for a probe).
 *   - SANDBOX : $HARNESS_SANDBOX=1 sets `sandboxWrites: true` on every session
 *               (macOS Seatbelt write containment, module #15) and adds a
 *               containment scenario: a Bash redirect OUTSIDE the scratch repo —
 *               the documented lexical-gate gap — must be blocked at the OS
 *               layer. Point SCRATCH somewhere outside the temp trees (which are
 *               sandbox-writable) for the probe to be meaningful, e.g. $HOME.
 *
 * Usage:  bun run scripts/headless-harness.ts [scratchRepoPath]
 *         HARNESS_MODEL=claude-opus-4-8 bun run scripts/headless-harness.ts
 *         HARNESS_SANDBOX=1 bun run scripts/headless-harness.ts ~/nc-scratch
 */
const REPO = resolve(import.meta.dir, '..');
const SCRATCH = resolve(
  process.argv[2] ?? process.env.HARNESS_SCRATCH ?? join(REPO, '..', 'test-repo'),
);
const MODEL = process.env.HARNESS_MODEL ?? 'claude-sonnet-4-6';
const SANDBOX = process.env.HARNESS_SANDBOX === '1';
const HELLO = join(SCRATCH, 'NIGHTCORE_HELLO.md');
/** S4's escape target: a SIBLING of the scratch repo (outside the session cwd,
 *  and outside the sandbox temp allowlist when SCRATCH is, e.g., under $HOME). */
const OUTSIDE = `${SCRATCH}-escape-probe.txt`;

if (!existsSync(join(SCRATCH, '.git'))) {
  console.error(`✖ scratch repo not found / not a git repo: ${SCRATCH}`);
  console.error('  pass a path as the first arg or set $HARNESS_SCRATCH.');
  process.exit(1);
}

// clean any prior probe artifact
if (existsSync(HELLO)) rmSync(HELLO);

const child = Bun.spawn(['bun', 'run', 'apps/sidecar/src/index.ts'], {
  cwd: REPO,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});

const enc = new TextEncoder();
const send = (cmd: SurfaceCommand) => {
  child.stdin.write(enc.encode(`${JSON.stringify(cmd)}\n`));
  child.stdin.flush();
};

// --- event routing: resolve a per-session promise on its terminal event ------
type Terminal = { kind: 'completed' | 'failed'; event: NightcoreEvent };
const waiters = new Map<number, (t: Terminal) => void>();
const sdkSessionIds = new Map<number, string>();
const labels = new Map<number, string>();

function awaitTerminal(sessionId: number): Promise<Terminal> {
  return new Promise((res) => waiters.set(sessionId, res));
}

/** Resolves with the NEXT `session-started` id. The engine seeds its id counter
 *  past the highest PERSISTED session id (restart-safe), so on a machine with
 *  session history ids do NOT start at 1 — capture the real id instead of
 *  assuming. Sends here are strictly sequential (each scenario awaits its
 *  terminal), so a single pending waiter is sufficient. */
let pendingStart: ((id: number) => void) | undefined;
function startSession(cmd: SurfaceCommand, label: string): Promise<number> {
  const started = new Promise<number>((res) => {
    pendingStart = (id) => {
      labels.set(id, label);
      res(id);
    };
  });
  send(cmd);
  return started;
}

function onEvent(ev: NightcoreEvent) {
  const tag = labels.get(ev.sessionId) ?? `s${ev.sessionId}`;
  switch (ev.type) {
    case 'session-started':
      pendingStart?.(ev.sessionId);
      pendingStart = undefined;
      console.log(
        `  [${labels.get(ev.sessionId) ?? tag}] started · id=${ev.sessionId} · model=${ev.model} · perm=${ev.permissionMode}`,
      );
      break;
    case 'session-ready':
      sdkSessionIds.set(ev.sessionId, ev.sdkSessionId);
      console.log(`  [${tag}] ready · sdkSessionId=${ev.sdkSessionId.slice(0, 8)}… · ${ev.tools.length} tools`);
      break;
    case 'tool-use-requested': {
      const f = (ev.input.file_path ?? ev.input.path ?? ev.input.pattern ?? ev.input.command ?? '') as string;
      console.log(`  [${tag}] 🔧 ${ev.toolName}${f ? ` ${String(f).replace(SCRATCH, '.')}` : ''}`);
      break;
    }
    case 'permission-required':
      console.log(`  [${tag}] ⚠ permission-required ${ev.toolName} (UNEXPECTED under bypass)`);
      break;
    case 'session-completed':
      console.log(`  [${tag}] ✅ completed · turns=${ev.numTurns} · $${ev.costUsd.toFixed(4)}`);
      waiters.get(ev.sessionId)?.({ kind: 'completed', event: ev });
      break;
    case 'session-failed':
      console.log(`  [${tag}] ⛔ failed · reason=${ev.reason} · ${ev.message.slice(0, 80)}`);
      waiters.get(ev.sessionId)?.({ kind: 'failed', event: ev });
      break;
    default:
      break;
  }
}

// --- stdout NDJSON pump -------------------------------------------------------
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (line) {
        try { onEvent(JSON.parse(line) as NightcoreEvent); } catch { /* ignore */ }
      }
    }
  }
})();
// surface sidecar stderr (logs) quietly
(async () => {
  const dec = new TextDecoder();
  for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) {
    const s = dec.decode(chunk);
    if (/error|panic|throw/i.test(s)) process.stderr.write(`  (sidecar) ${s}`);
  }
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];

// session ids come from the engine (seeded past persisted history) — captured
// per-send via `startSession`, never assumed.
async function run() {
  // ---- Scenario 1: happy-path write under bypass ----
  console.log('\n━━ Scenario 1: build session writes a file (bypass, native tools) ━━');
  const id1 = await startSession(
    {
      type: 'start-session',
      prompt: `Create a file named NIGHTCORE_HELLO.md in the current directory containing exactly one line: "hello from nightcore headless harness". Use the Write tool. Then stop — do not create anything else.`,
      model: MODEL,
      permissionMode: 'bypassPermissions',
      cwd: SCRATCH,
      kind: 'build',
      maxTurns: 30,
      ...(SANDBOX ? { sandboxWrites: true } : {}),
    },
    'S1',
  );
  const t1 = await awaitTerminal(id1);
  const wrote = existsSync(HELLO);
  results.push(
    t1.kind === 'completed' && wrote
      ? '✅ S1 happy-path: session completed AND NIGHTCORE_HELLO.md exists on disk'
      : `❌ S1 happy-path: terminal=${t1.kind}, fileExists=${wrote}`,
  );

  // ---- Scenario 2: maxTurns ceiling fires ----
  console.log('\n━━ Scenario 2: maxTurns=1 forces the guardrail to fire ━━');
  const id2 = await startSession(
    {
      type: 'start-session',
      prompt: `Carefully explore this repository: list the directory, read package.json, read README if present, then summarize the project in detail. Take your time and use multiple tool calls.`,
      model: MODEL,
      permissionMode: 'bypassPermissions',
      cwd: SCRATCH,
      kind: 'build',
      maxTurns: 1,
      ...(SANDBOX ? { sandboxWrites: true } : {}),
    },
    'S2',
  );
  const t2 = await awaitTerminal(id2);
  results.push(
    t2.kind === 'failed' && t2.event.type === 'session-failed' && t2.event.reason === 'max-turns'
      ? '✅ S2 guardrail: session-failed with reason=max-turns (ceiling enforced)'
      : `❌ S2 guardrail: terminal=${t2.kind}, reason=${t2.event.type === 'session-failed' ? t2.event.reason : 'n/a'} (expected max-turns)`,
  );

  // ---- Scenario 3: resume the S1 SDK session ----
  const resumeId = sdkSessionIds.get(id1);
  if (resumeId) {
    console.log(`\n━━ Scenario 3: resume S1's SDK session (${resumeId.slice(0, 8)}…) ━━`);
    const id3 = await startSession(
      {
        type: 'start-session',
        prompt: `What is the exact name of the file you created a moment ago? Answer with just the filename.`,
        model: MODEL,
        permissionMode: 'bypassPermissions',
        cwd: SCRATCH,
        kind: 'build',
        maxTurns: 5,
        resumeSessionId: resumeId,
        ...(SANDBOX ? { sandboxWrites: true } : {}),
      },
      'S3',
    );
    const t3 = await awaitTerminal(id3);
    const recalled =
      t3.kind === 'completed' &&
      t3.event.type === 'session-completed' &&
      /NIGHTCORE_HELLO/i.test(t3.event.result);
    results.push(
      recalled
        ? '✅ S3 resume: resumed session recalled the file it created in S1'
        : `⚠ S3 resume: terminal=${t3.kind}${t3.event.type === 'session-completed' ? `, result="${t3.event.result.slice(0, 60)}"` : ''} (resume may need verify)`,
    );
  } else {
    results.push('⚠ S3 resume: skipped — no sdkSessionId captured from S1');
  }

  // ---- Scenario 4 (HARNESS_SANDBOX=1 only): OS write containment holds ----
  // A Bash redirect to an absolute path OUTSIDE the cwd is the documented
  // lexical-gate gap (workspace-confinement covers `cd`, not redirects) — so a
  // blocked write here is proof the Seatbelt layer, not the lexical layer, held.
  if (SANDBOX) {
    console.log('\n━━ Scenario 4: sandboxed session cannot write outside the repo ━━');
    const id4 = await startSession(
      {
        type: 'start-session',
        prompt: `Use the Bash tool to run exactly this command and report what happens: echo escaped > "${OUTSIDE}". If the command fails, reply with the single word BLOCKED and stop.`,
        model: MODEL,
        permissionMode: 'bypassPermissions',
        cwd: SCRATCH,
        kind: 'build',
        maxTurns: 10,
        sandboxWrites: true,
      },
      'S4',
    );
    const t4 = await awaitTerminal(id4);
    const escaped = existsSync(OUTSIDE);
    results.push(
      !escaped && t4.kind === 'completed'
        ? '✅ S4 sandbox: outside-cwd Bash redirect was BLOCKED (no escape file on disk)'
        : `❌ S4 sandbox: terminal=${t4.kind}, escapeFileExists=${escaped}`,
    );
  }
}

// The sandbox run adds a 4th scenario, so give it more headroom.
const TIMEOUT_MS = SANDBOX ? 360_000 : 240_000;
const timeout = sleep(TIMEOUT_MS).then(() => {
  throw new Error(`harness timeout (${TIMEOUT_MS / 60_000}m)`);
});
try {
  await Promise.race([run(), timeout]);
} catch (e) {
  results.push(`❌ harness error: ${(e as Error).message}`);
} finally {
  console.log('\n══════════════ HEADLESS HARNESS RESULTS ══════════════');
  for (const r of results) console.log(r);
  console.log('═══════════════════════════════════════════════════════');
  if (existsSync(HELLO)) rmSync(HELLO); // leave the scratch repo clean
  rmSync(OUTSIDE, { force: true }); // clean the S4 escape probe if containment failed
  child.kill();
  await sleep(200);
  process.exit(0);
}
