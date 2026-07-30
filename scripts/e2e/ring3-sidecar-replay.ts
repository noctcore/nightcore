#!/usr/bin/env bun
/**
 * E2E ladder **ring 3** — the real Bun sidecar, driven by the fake provider (#406).
 *
 * ## What this ring is
 *
 * Ring 1 drives the run engine's subsystems in-process (`tauri::test` MockRuntime, no
 * child, no pipe). `dogfood:engine` drives the real sidecar but needs a live Claude
 * account, a network, and spend — so it can never run in CI. Ring 3 is the missing
 * middle: the REAL sidecar child, over its REAL NDJSON stdio protocol, with a
 * **checked-in transcript** standing in for the model. Everything between the fixture
 * and the assertion is production code —
 *
 *   engine `SessionManager` (id assignment, supervision, status transitions)
 *     → the provider seam (`ReplayAgentProvider`)
 *       → the sidecar's OUTBOUND `NightcoreEventSchema` validation
 *         → NDJSON framing + the backpressure writer
 *           → a real OS pipe
 *
 * — so this is the first ring that proves the process boundary itself, at zero cost
 * and with a byte-reproducible result. It is the offline half of the pair the issue
 * asks for; `dogfood:engine` remains the live-model probe.
 *
 * ## Usage
 *
 *   bun run e2e:ring3              # the battery (CI runs exactly this)
 *   bun run e2e:ring3 --prove      # + the anti-vacuity proof (see PROVE below)
 *
 * ## Determinism
 *
 * The child gets a temp `HOME`, so the engine's session store starts empty and session
 * ids are `1..n` on every machine; the transcript is a file, not a model; no timers
 * pace the replay. Two runs of the same scenario are compared byte-for-byte by the
 * `is deterministic` check below — the claim is PROVEN here, not asserted in a README.
 *
 * ## PROVE — why this job cannot pass vacuously
 *
 * A CI job that would pass with the system broken is worse than no job. `--prove`
 * copies the fixtures to a temp dir, changes ONE field inside `build.jsonl`, re-runs
 * the identical battery against the perturbed copy, and REQUIRES it to fail. If the
 * battery still passes, the battery is not really comparing payloads and `--prove`
 * exits non-zero. Same shape as `scripts/verify-drift-guard.ts`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type NightcoreEvent,
  NightcoreEventSchema,
  type SurfaceCommand,
} from '@nightcore/contracts';

const REPO = path.resolve(import.meta.dir, '../..');
/** The ONE copy of the ladder's transcripts, shared with ring 1(c)'s Rust drivers. */
const FIXTURES = path.join(
  REPO,
  'apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures',
);
const SIDECAR_ENTRY = path.join(REPO, 'apps/sidecar/src/index.ts');
/** Ceiling for one scenario. The replay is unpaced (milliseconds in practice); this
 *  only exists so a wedged child fails the ring fast instead of burning the job. */
const SCENARIO_TIMEOUT_MS = 30_000;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** One live sidecar child plus its parsed event stream. */
class Sidecar {
  private readonly child: ReturnType<typeof spawn>;
  private buffer = '';
  private readonly events: NightcoreEvent[] = [];
  private readonly rawLines: string[] = [];
  private readonly invalid: string[] = [];
  readonly stderr: string[] = [];
  private waiters: Array<() => void> = [];

  constructor(transcriptDir: string, home: string) {
    this.child = spawn('bun', ['run', SIDECAR_ENTRY], {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The switch under test. Also the ONLY thing standing between this ring and a
        // live provider, which is why the engine throws when it is unusable.
        NIGHTCORE_E2E_REPLAY: transcriptDir,
        // Hermetic: a fresh engine session store ⇒ ids start at 1 on every machine,
        // and the developer's real ~/.nightcore is never touched.
        HOME: home,
        USERPROFILE: home,
      },
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString('utf8'));
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf('\n');
      if (line.length === 0) continue;
      this.rawLines.push(line);
      // Validate EVERY line off the real pipe against the wire contract. The sidecar
      // validates outbound too, so a failure here means the two disagree — exactly the
      // cross-boundary drift this ring exists to catch.
      const parsed = NightcoreEventSchema.safeParse(JSON.parse(line) as unknown);
      if (parsed.success) this.events.push(parsed.data);
      else this.invalid.push(line);
    }
    for (const wake of this.waiters.splice(0)) wake();
  }

  send(command: SurfaceCommand): void {
    this.child.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  /** Resolve once an event satisfying `match` has been seen (or reject on timeout). */
  waitFor(match: (event: NightcoreEvent) => boolean): Promise<NightcoreEvent> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `timed out after ${SCENARIO_TIMEOUT_MS}ms; saw [${this.events
              .map((e) => e.type)
              .join(', ')}]; sidecar stderr: ${this.stderr.join('').slice(-800)}`,
          ),
        );
      }, SCENARIO_TIMEOUT_MS);
      const check = () => {
        const hit = this.events.find(match);
        if (hit === undefined) {
          this.waiters.push(check);
          return;
        }
        clearTimeout(deadline);
        resolve(hit);
      };
      check();
    });
  }

  seen(): NightcoreEvent[] {
    return [...this.events];
  }

  invalidLines(): string[] {
    return [...this.invalid];
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.child.kill();
  }
}

/** Read a fixture as the ordered events it will be replayed as. */
function fixtureEvents(dir: string, name: string): NightcoreEvent[] {
  return fs
    .readFileSync(path.join(dir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as NightcoreEvent);
}

/** Deep-compare two event lists, ignoring `sessionId` (the live id is assigned by the
 *  supervisor and is deliberately NOT the recorded one). */
function sameEvents(a: NightcoreEvent[], b: NightcoreEvent[]): boolean {
  const strip = (events: NightcoreEvent[]) =>
    JSON.stringify(
      events.map((e) => {
        const copy: Record<string, unknown> = { ...e };
        delete copy.sessionId;
        return copy;
      }),
    );
  return strip(a) === strip(b);
}

/**
 * The battery. Returns one {@link CheckResult} per named check.
 *
 * `replayDir` is what the sidecar REPLAYS; `expectDir` is what the assertions COMPARE
 * AGAINST. In a normal run they are the same canonical directory. They are separate
 * parameters because they must be: the first draft of this script read the expectation
 * out of `replayDir`, which made the payload comparison self-referential — perturbing
 * the fixture moved both sides and the battery stayed green. `--prove` caught it
 * immediately, which is the entire reason `--prove` exists. The expectation is now
 * pinned to the checked-in fixture, so a perturbed input HAS to trip it.
 */
async function runBattery(
  replayDir: string,
  expectDir: string = replayDir,
): Promise<CheckResult[]> {
  const transcriptDir = replayDir;
  const results: CheckResult[] = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ring3-home-'));
  const sidecar = new Sidecar(transcriptDir, home);

  const start = (prompt: string): SurfaceCommand => ({
    type: 'start-session',
    prompt,
    model: 'replay-fixture',
    cwd: REPO,
    kind: 'build',
  });

  try {
    // ---- Scenario 1: the recorded build run reaches the wire unchanged ------------
    sidecar.send(start('replay the build transcript'));
    const completed = await sidecar.waitFor((e) => e.type === 'session-completed');
    const liveId = (completed as { sessionId: number }).sessionId;
    const recorded = fixtureEvents(expectDir, 'build');
    const replayed = sidecar
      .seen()
      .filter(
        (e) =>
          'sessionId' in e &&
          (e as { sessionId: number }).sessionId === liveId &&
          recorded.some((r) => r.type === e.type),
      );
    results.push({
      name: 'build transcript survives the real process boundary line-for-line',
      ok: sameEvents(replayed, recorded),
      detail: sameEvents(replayed, recorded)
        ? `${recorded.length} recorded events matched`
        : `expected ${recorded.map((e) => e.type).join(',')} got ${replayed
            .map((e) => e.type)
            .join(',')}`,
    });

    // The supervisor's own lifecycle events must bracket the replay: they come from
    // production code, not the fixture, so their absence means the run never really
    // went through SessionManager.
    const lifecycle = sidecar
      .seen()
      .filter(
        (e) =>
          'sessionId' in e &&
          (e as { sessionId: number }).sessionId === liveId &&
          (e.type === 'session-started' || e.type === 'session-status'),
      );
    results.push({
      name: 'the supervisor bracketed the replay with its own lifecycle events',
      ok: lifecycle.some((e) => e.type === 'session-started'),
      detail: `saw [${lifecycle.map((e) => e.type).join(', ')}]`,
    });

    // ---- Scenario 2: the failure transcript settles as a real failure -------------
    sidecar.send(start('#replay build-failed'));
    const failed = (await sidecar.waitFor(
      (e) => e.type === 'session-failed' && (e as { reason: string }).reason !== 'runner-crash',
    )) as unknown as { reason: string; message: string };
    results.push({
      name: 'the failure transcript settles as session-failed(max-turns)',
      ok: failed.reason === 'max-turns',
      detail: `reason=${failed.reason}`,
    });

    // ---- Scenario 3: a missing transcript fails LOUDLY, over the real boundary ----
    // The fail-loud property is only worth anything if it survives the pipe: a run
    // that silently produced nothing would look identical to a passing one from here.
    sidecar.send(start('#replay no-such-transcript'));
    const crashed = (await sidecar.waitFor(
      (e) => e.type === 'session-failed' && (e as { reason: string }).reason === 'runner-crash',
    )) as unknown as { message: string };
    results.push({
      name: 'a missing transcript surfaces as a diagnosable terminal failure',
      ok: crashed.message.includes('no-such-transcript.jsonl'),
      detail: crashed.message.slice(0, 120),
    });

    // ---- Every byte on the wire was contract-valid --------------------------------
    results.push({
      name: 'every line on the real pipe validated against NightcoreEventSchema',
      ok: sidecar.invalidLines().length === 0,
      detail:
        sidecar.invalidLines().length === 0
          ? `${sidecar.seen().length} events`
          : `invalid: ${sidecar.invalidLines().slice(0, 2).join(' | ')}`,
    });
  } catch (error) {
    results.push({
      name: 'battery completed',
      ok: false,
      detail: String(error),
    });
  } finally {
    await sidecar.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  return results;
}

/** Replay one scenario twice in two fresh children and compare the streams. */
async function determinismCheck(transcriptDir: string): Promise<CheckResult> {
  const capture = async (): Promise<NightcoreEvent[]> => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ring3-det-'));
    const sidecar = new Sidecar(transcriptDir, home);
    try {
      sidecar.send({
        type: 'start-session',
        prompt: 'replay the build transcript',
        model: 'replay-fixture',
        cwd: REPO,
        kind: 'build',
      });
      await sidecar.waitFor((e) => e.type === 'session-completed');
      return sidecar.seen();
    } finally {
      await sidecar.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  const [a, b] = [await capture(), await capture()];
  // Full equality INCLUDING session ids: the temp HOME makes the id counter start
  // from the same place, so two runs must be byte-identical, not merely equivalent.
  const ok = JSON.stringify(a) === JSON.stringify(b);
  return {
    name: 'two independent runs produce a byte-identical event stream',
    ok,
    detail: ok ? `${a.length} events, identical` : 'streams diverged',
  };
}

function report(title: string, results: CheckResult[]): boolean {
  console.log(`\n══ ${title} ══`);
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✖'} ${r.name}\n    ${r.detail}`);
  }
  return results.every((r) => r.ok);
}

/**
 * The anti-vacuity proof: perturb the input the ring reads, re-run the SAME battery,
 * and require it to FAIL. Mirrors `scripts/verify-drift-guard.ts` — a guard nobody has
 * ever seen trip is not a guard.
 */
async function prove(): Promise<boolean> {
  /** Copy the fixtures somewhere writable and apply `mutate` to `build.jsonl`. */
  const perturbedCopy = (mutate: (raw: string) => string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ring3-perturbed-'));
    for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.jsonl'))) {
      fs.copyFileSync(path.join(FIXTURES, file), path.join(dir, file));
    }
    const target = path.join(dir, 'build.jsonl');
    const before = fs.readFileSync(target, 'utf8');
    const after = mutate(before);
    if (after === before) {
      throw new Error(
        'perturbation did not change build.jsonl — the fixture text moved; update prove()',
      );
    }
    fs.writeFileSync(target, after);
    return dir;
  };

  /** The two ways the pipeline can silently lie: it mangles an event, or it loses
   *  one. The battery must trip on BOTH, or it is only counting events. */
  const perturbations: Array<{ label: string; mutate: (raw: string) => string }> = [
    {
      label: 'one payload field rewritten (the pipeline mangled an event)',
      mutate: (raw) => raw.replace('Awaited the save() call', 'PERTURBED by prove'),
    },
    {
      label: 'one event line dropped (the pipeline lost an event)',
      mutate: (raw) =>
        raw
          .split('\n')
          .filter((line) => !line.includes('"toolUseId":"tu-2"') || !line.includes('tool-result'))
          .join('\n'),
    },
  ];

  console.log('\n══ PROVE: the same battery, against perturbed fixtures ══');
  let allTripped = true;
  for (const { label, mutate } of perturbations) {
    const dir = perturbedCopy(mutate);
    // Replay the PERTURBED copy, but compare against the CANONICAL fixtures — the
    // perturbation stands in for "the pipeline corrupted/lost an event".
    const results = await runBattery(dir, FIXTURES);
    fs.rmSync(dir, { recursive: true, force: true });
    const payloadCheck = results.find((r) =>
      r.name.startsWith('build transcript survives'),
    );
    const tripped = payloadCheck !== undefined && !payloadCheck.ok;
    console.log(`${tripped ? '✔' : '✖'} tripped on: ${label}`);
    if (!tripped) allTripped = false;
  }

  if (allTripped) {
    console.log(
      '\n✔ PROVE: the battery TRIPPED on every perturbation — it compares real payloads, not shapes',
    );
    return true;
  }
  console.error(
    '\n✖ PROVE: the battery survived a perturbation. It is VACUOUS — fix the battery, not this script.',
  );
  return false;
}

async function main(): Promise<void> {
  const shouldProve = process.argv.includes('--prove');
  const results = await runBattery(FIXTURES);
  results.push(await determinismCheck(FIXTURES));
  let ok = report('E2E ladder ring 3 — sidecar × replay provider', results);
  if (shouldProve) ok = (await prove()) && ok;
  console.log(ok ? '\n✔ ring 3 green' : '\n✖ ring 3 RED');
  process.exit(ok ? 0 : 1);
}

await main();
