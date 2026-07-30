#!/usr/bin/env bun
/**
 * E2E ladder **ring 2** — the real desktop app, driven by a real WebDriver (#406).
 *
 * ## Why this ring is Linux-only, and why it is the only one of its kind
 *
 * macOS's WKWebView exposes no CDP and no WebDriver endpoint — the constraint that
 * shapes every other tier of this ladder (`reference_nightcore_ui_testing`, and the
 * reason `dogfood:ui` drives a mock web app at :5173 instead of the app). Linux's
 * WebKitGTK ships `WebKitWebDriver`, which `tauri-driver` fronts, so Linux is the ONE
 * platform where CI can drive the actual Tauri window. Everything below therefore runs
 * on ubuntu only, under Xvfb.
 *
 * It is also the only tier that exercises the layer nothing else touches: the Tauri
 * window + WebKit webview + the IPC bridge into the Rust core, in the SHIPPED binary.
 * Ring 1 has no webview; the vitest browser suite has no Rust; ring 3 has no window.
 *
 * ## What it asserts (and why each check cannot pass vacuously)
 *
 *  1. the window came up and is titled — the app process launched at all;
 *  2. `window.__TAURI_INTERNALS__` exists AND the app's own "Browser preview" banner is
 *     absent — we are in the real webview, not accidentally pointed at a dev server
 *     serving mock data (the single most likely way this ring becomes a lie);
 *  3. `invoke('app_info')` returns the version compiled into the binary — a real IPC
 *     round-trip into Rust and back, not a painted bundle;
 *  4. `invoke('list_tasks')` returns exactly the tasks this script seeded on disk —
 *     the Rust store read OUR state, so the run is hermetic and the count is known;
 *  5. the seeded task titles are present in the rendered DOM — React rendered data
 *     that came from Rust, which is the actual end-to-end claim;
 *  6. no `*.corrupt-*` file appeared in the seeded config dir — a quarantined store
 *     would otherwise leave an empty board that satisfies a weaker assertion.
 *
 * ## SELF-TEST — why this job cannot pass with the app broken
 *
 * `--self-test` (on by default in CI) perturbs the LIVE app and requires the battery
 * to trip: it empties `#root` and re-runs the DOM checks (all must fail), then makes
 * `invoke` reject and re-runs the IPC checks (all must fail). A check that survives
 * its own perturbation is not reading the app, and the run exits non-zero saying so.
 * Same contract as `scripts/verify-drift-guard.ts`.
 *
 * ## Usage
 *
 *   bun run e2e:ring2                       # binary from the default debug path
 *   bun run e2e:ring2 -- --binary <path>    # explicit binary
 *   bun run e2e:ring2 -- --no-self-test     # battery only
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { waitForDriver,WebDriverSession } from './webdriver.js';

const REPO = path.resolve(import.meta.dir, '../..');
const FIXTURES = path.join(
  REPO,
  'apps/desktop/src-tauri/src/e2e/transcript_replay/fixtures',
);
/** Where `tauri build --debug --no-bundle` leaves the executable. Both spellings are
 *  probed: cargo names it after the crate (`nightcore`), while some Tauri CLI versions
 *  rename it to `productName`. Resolving instead of assuming keeps a CLI upgrade from
 *  turning this ring into a "binary not found" red for a reason unrelated to the app. */
const BINARY_CANDIDATES = ['nightcore', 'Nightcore'].map((name) =>
  path.join(REPO, 'apps/desktop/src-tauri/target/debug', name),
);
/** The Tauri identifier — `app_config_dir()` joins THIS, never productName. */
const APP_IDENTIFIER = 'dev.shirone.nightcore';
const DRIVER_URL = 'http://127.0.0.1:4444';
/** The app shows a splash for a fixed 1400 ms and clears it once the boot reads
 *  settle; give it comfortable headroom on a cold CI runner before asserting. */
const BOOT_SETTLE_MS = 6_000;

interface Check {
  name: string;
  /** `dom` checks read the rendered page; `ipc` checks make a Tauri round-trip. The
   *  tag drives the self-test: each perturbation targets one class and demands that
   *  EVERY check in it fails. */
  kind: 'dom' | 'ipc' | 'disk';
  run: (session: WebDriverSession) => Promise<{ ok: boolean; detail: string }>;
}

/** The seeded board. Titles are distinctive so finding them in the DOM cannot be an
 *  accident (a substring of the app's own chrome would make check 5 vacuous). */
const SEED_TASKS = [
  { id: 'ring2-alpha', title: 'ring2 seeded alpha task', status: 'backlog' },
  { id: 'ring2-bravo', title: 'ring2 seeded bravo task', status: 'ready' },
  { id: 'ring2-charlie', title: 'ring2 seeded charlie task', status: 'done' },
];

interface Workspace {
  /** The throwaway root holding everything below (removed at the end of the run). */
  root: string;
  /** XDG_CONFIG_HOME for the app run. */
  xdgConfigHome: string;
  /** XDG_DATA_HOME for the app run — where its rolling log lands. */
  xdgDataHome: string;
  /** `<xdgConfigHome>/<identifier>` — where projects.json/settings.json land. */
  configDir: string;
  /** The scratch git repo the seeded project points at. */
  projectPath: string;
}

/** Create a throwaway XDG config/data home + scratch project with a seeded board. */
function seedWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ring2-'));
  const xdgConfigHome = path.join(root, 'config');
  const xdgDataHome = path.join(root, 'data');
  const configDir = path.join(xdgConfigHome, APP_IDENTIFIER);
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.nightcore/tasks'), { recursive: true });
  // A real git dir: the project is a git repo everywhere in the core's model, and a
  // bare marker is enough for the boot reads (no run is launched by this ring).
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });

  const now = Date.now();
  fs.writeFileSync(
    path.join(configDir, 'projects.json'),
    JSON.stringify(
      [
        {
          id: 'ring2-project',
          name: 'Ring 2 scratch',
          path: projectPath,
          branch: null,
          createdAt: new Date(now).toISOString(),
          lastActiveAt: null,
        },
      ],
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(configDir, 'active.json'),
    JSON.stringify({ activeProjectId: 'ring2-project' }),
  );
  for (const task of SEED_TASKS) {
    fs.writeFileSync(
      path.join(projectPath, '.nightcore/tasks', `${task.id}.json`),
      JSON.stringify({
        id: task.id,
        title: task.title,
        description: '',
        status: task.status,
        dependencies: [],
        model: null,
        branch: null,
        createdAt: now,
        updatedAt: now,
        sessionId: null,
        summary: null,
        error: null,
        costUsd: null,
      }),
    );
  }
  return { root, xdgConfigHome, xdgDataHome, configDir, projectPath };
}

/** Tail the app's own rolling log. This ring is developed and debugged through CI (no
 *  macOS developer can run tauri-driver locally), so a failure that prints only
 *  "check X failed" is a failure nobody can diagnose. */
function appLogTail(workspace: Workspace, lines = 80): string {
  const dir = path.join(workspace.xdgDataHome, APP_IDENTIFIER, 'logs');
  if (!fs.existsSync(dir)) return `(no app log dir at ${dir})`;
  const files = fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) return `(app log dir ${dir} is empty)`;
  return fs.readFileSync(files[0]!, 'utf8').split('\n').slice(-lines).join('\n');
}

/** The version compiled into the binary, read from the crate manifest so the check
 *  can never drift into comparing a constant against itself. */
function expectedVersion(): string {
  const manifest = fs.readFileSync(
    path.join(REPO, 'apps/desktop/src-tauri/Cargo.toml'),
    'utf8',
  );
  const match = /^version = "([^"]+)"/m.exec(manifest);
  if (match === null) throw new Error('could not read version from Cargo.toml');
  return match[1]!;
}

/** Invoke a Tauri command from inside the page and return its result or an error. */
const INVOKE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    done({ ok: false, error: 'no __TAURI_INTERNALS__.invoke' });
  } else {
    Promise.resolve(internals.invoke(arguments[0], arguments[1] || {}))
      .then((value) => done({ ok: true, value }))
      .catch((error) => done({ ok: false, error: String(error) }));
  }
`;

type InvokeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function invoke<T>(
  session: WebDriverSession,
  command: string,
  args: Record<string, unknown> = {},
): Promise<InvokeResult<T>> {
  return session.executeAsync<InvokeResult<T>>(INVOKE_SCRIPT, [command, args]);
}

function buildChecks(workspace: Workspace): Check[] {
  const version = expectedVersion();
  return [
    {
      name: 'the Tauri window opened and is titled Nightcore',
      kind: 'dom',
      run: async (session) => {
        const title = await session.title();
        return { ok: title === 'Nightcore', detail: `title=${JSON.stringify(title)}` };
      },
    },
    {
      name: 'we are in the REAL webview, not a browser-preview dev server',
      kind: 'dom',
      run: async (session) => {
        // Two independent signals: the Tauri IPC shim exists, AND the app's own
        // "you are not in Tauri" banner is absent. Either alone could be fooled.
        const probe = await session.execute<{ internals: boolean; banner: boolean }>(`
          return {
            internals: typeof window.__TAURI_INTERNALS__ === 'object' && window.__TAURI_INTERNALS__ !== null,
            banner: (document.body.innerText || '').includes('Browser preview'),
          };
        `);
        return {
          ok: probe.internals && !probe.banner,
          detail: `internals=${probe.internals} previewBanner=${probe.banner}`,
        };
      },
    },
    {
      name: 'the app shell painted a non-trivial DOM',
      kind: 'dom',
      run: async (session) => {
        const count = await session.execute<number>(
          "return document.querySelectorAll('#root *').length;",
        );
        // A white screen (React crashed on mount, CSP blocked the bundle, assets
        // missing) leaves #root empty or nearly so; a real shell is hundreds of nodes.
        return { ok: count > 50, detail: `${count} elements under #root` };
      },
    },
    {
      name: 'app_info round-tripped through the Rust core',
      kind: 'ipc',
      run: async (session) => {
        const result = await invoke<{ version: string }>(session, 'app_info');
        const ok = result.ok && result.value.version === version;
        return {
          ok,
          detail: result.ok
            ? `version=${result.value.version} (expected ${version})`
            : `invoke failed: ${result.error}`,
        };
      },
    },
    {
      name: 'list_tasks returned exactly the board this ring seeded on disk',
      kind: 'ipc',
      run: async (session) => {
        const result = await invoke<Array<{ id: string }>>(session, 'list_tasks');
        if (!result.ok) return { ok: false, detail: `invoke failed: ${result.error}` };
        const ids = result.value.map((t) => t.id).sort();
        const want = SEED_TASKS.map((t) => t.id).sort();
        return {
          ok: JSON.stringify(ids) === JSON.stringify(want),
          detail: `got [${ids.join(', ')}] want [${want.join(', ')}]`,
        };
      },
    },
    {
      name: 'the seeded task titles are rendered in the live DOM',
      kind: 'dom',
      run: async (session) => {
        const text = await session.execute<string>(
          'return document.body.innerText || "";',
        );
        const missing = SEED_TASKS.filter((t) => !text.includes(t.title));
        return {
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? `all ${SEED_TASKS.length} seeded titles present`
              : `missing: ${missing.map((t) => t.title).join(', ')}`,
        };
      },
    },
    {
      name: 'no store file was quarantined as corrupt during the run',
      kind: 'disk',
      run: () => {
        // The core quarantines an unparsable projects.json/settings.json to
        // `<name>.corrupt-<millis>` and carries on with an EMPTY registry — which
        // would leave a board that still satisfies weaker checks. This is the
        // tripwire for a seed that silently stopped matching the Rust structs.
        const corrupt = fs
          .readdirSync(workspace.configDir)
          .filter((f) => f.includes('.corrupt-'));
        return Promise.resolve({
          ok: corrupt.length === 0,
          detail: corrupt.length === 0 ? 'clean' : `quarantined: ${corrupt.join(', ')}`,
        });
      },
    },
  ];
}

interface Outcome {
  name: string;
  kind: Check['kind'];
  ok: boolean;
  detail: string;
}

async function runChecks(
  session: WebDriverSession,
  checks: Check[],
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const check of checks) {
    try {
      const { ok, detail } = await check.run(session);
      outcomes.push({ name: check.name, kind: check.kind, ok, detail });
    } catch (error) {
      outcomes.push({
        name: check.name,
        kind: check.kind,
        ok: false,
        detail: String(error),
      });
    }
  }
  return outcomes;
}

/**
 * Perturb the live app and require the matching checks to trip. A check that still
 * passes after the thing it claims to read has been destroyed is not reading it.
 */
async function selfTest(
  session: WebDriverSession,
  checks: Check[],
): Promise<boolean> {
  console.log('\n══ SELF-TEST: perturb the live app, require the checks to trip ══');
  let allTripped = true;

  const perturbations: Array<{
    label: string;
    kind: Check['kind'];
    script: string;
  }> = [
    {
      label: 'empty #root (the webview rendered nothing)',
      kind: 'dom',
      // Also blanks the title, so the window-title check is covered by the same
      // perturbation rather than being exempted from the proof.
      script:
        "document.querySelector('#root').innerHTML = ''; document.title = ''; return true;",
    },
    {
      label: 'make invoke() reject (the Rust core stopped answering)',
      kind: 'ipc',
      script:
        "window.__TAURI_INTERNALS__.invoke = () => Promise.reject(new Error('self-test')); return true;",
    },
  ];

  for (const perturbation of perturbations) {
    await session.execute(perturbation.script);
    const targeted = checks.filter((c) => c.kind === perturbation.kind);
    const outcomes = await runChecks(session, targeted);
    const survivors = outcomes.filter((o) => o.ok);
    const tripped = survivors.length === 0;
    console.log(
      `${tripped ? '✔' : '✖'} ${perturbation.label} — ${outcomes.length} check(s), ${
        outcomes.length - survivors.length
      } tripped`,
    );
    for (const survivor of survivors) {
      console.error(`    ✖ VACUOUS: "${survivor.name}" still passed — ${survivor.detail}`);
    }
    if (!tripped) allTripped = false;
  }

  if (!allTripped) {
    console.error(
      '\n✖ SELF-TEST: at least one check passes with the app broken. That check is not reading the app.',
    );
  } else {
    console.log(
      '\n✔ SELF-TEST: every check tripped when its subject was destroyed — the battery reads the live app',
    );
  }
  return allTripped;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const explicit = argValue('--binary');
  const binary =
    explicit ?? BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  const wantSelfTest = !process.argv.includes('--no-self-test');
  if (binary === undefined || !fs.existsSync(binary)) {
    console.error(
      `✖ app binary not found (looked at ${BINARY_CANDIDATES.join(', ')})\n` +
        '  build it first: cd apps/desktop && bunx tauri build --debug --no-bundle',
    );
    process.exit(1);
  }

  const workspace = seedWorkspace();
  console.log(`ring 2 binary:    ${binary}`);
  console.log(`ring 2 workspace: ${workspace.configDir}`);
  console.log(`ring 2 project:   ${workspace.projectPath}`);

  // tauri-driver launches the app as its own child, so the app inherits THIS env:
  // the throwaway config/data homes (hermetic state + a log we can tail) and the
  // replay switch (so nothing in the app can reach a real provider even if a run were
  // somehow launched). No credential is placed in the environment.
  const driver = spawn('tauri-driver', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: workspace.xdgConfigHome,
      XDG_DATA_HOME: workspace.xdgDataHome,
      NIGHTCORE_E2E_REPLAY: FIXTURES,
    },
  });
  const driverLog: string[] = [];
  driver.stdout?.on('data', (c: Buffer) => driverLog.push(c.toString('utf8')));
  driver.stderr?.on('data', (c: Buffer) => driverLog.push(c.toString('utf8')));

  let ok = false;
  let session: WebDriverSession | undefined;
  try {
    await waitForDriver(DRIVER_URL);
    session = await WebDriverSession.open({ url: DRIVER_URL, application: binary });
    // The splash is a fixed 1400 ms plus the boot reads; assert only after it clears.
    await new Promise((resolve) => setTimeout(resolve, BOOT_SETTLE_MS));

    const checks = buildChecks(workspace);
    const outcomes = await runChecks(session, checks);
    console.log('\n══ E2E ladder ring 2 — tauri-driver × the real desktop app ══');
    for (const outcome of outcomes) {
      console.log(`${outcome.ok ? '✔' : '✖'} ${outcome.name}\n    ${outcome.detail}`);
    }
    ok = outcomes.every((o) => o.ok);

    // Only meaningful once the battery is green: proving that a FAILING check trips is
    // no proof at all. Perturbation also leaves the app unusable, so it runs last.
    if (ok && wantSelfTest) ok = await selfTest(session, checks);
    else if (!ok && wantSelfTest) {
      console.log('\n(self-test skipped: the battery is already red — fix that first)');
    }
  } catch (error) {
    console.error(`✖ ring 2 driver error: ${String(error)}`);
  } finally {
    // Diagnostics on ANY red, not just a thrown error: this ring can only be debugged
    // from a CI log, so a failing check must ship the app's own log with it.
    if (!ok) {
      console.error(`\n── tauri-driver log ──\n${driverLog.join('').slice(-2000)}`);
      console.error(`\n── app log ──\n${appLogTail(workspace)}`);
    }
    if (session) await session.close();
    driver.kill();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  }

  console.log(ok ? '\n✔ ring 2 green' : '\n✖ ring 2 RED');
  process.exit(ok ? 0 : 1);
}

await main();
