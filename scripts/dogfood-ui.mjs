// Playwright UI driver for the dogfood pass against the MOCK-MODE web (`bun run
// web` → Vite :5173). The live Tauri window is WKWebView (no CDP) and can't be
// driven; this exercises the React surfaces with mock data. Walks the board /
// projects / settings flows, screenshots each, and reports console errors.
//
// Usage:  bun run web        # in another terminal (serves :5173)
//         node scripts/dogfood-ui.mjs
//         BASE_URL=http://localhost:5173 OUT_DIR=/tmp/nc node scripts/dogfood-ui.mjs
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// playwright is a CJS dep of the web workspace; resolve it from there, portably.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../apps/web/package.json'));
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = process.env.OUT_DIR ?? '/tmp/nightcore-dogfood';
mkdirSync(OUT, { recursive: true });
const errors = [];
const log = (...a) => console.log('•', ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log('shot', name);
};

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot('01-initial');

// --- Projects view ---
const projectsNav = page.getByRole('button', { name: /Projects/ }).first();
if (await projectsNav.isVisible().catch(() => false)) {
  await projectsNav.click();
  await page.waitForTimeout(300);
}
await shot('02-projects');

// Kebab menu on the project card (the bug under test)
const kebab = page.getByRole('button', { name: /more|menu|options/i }).first();
let kebabFound = await kebab.isVisible().catch(() => false);
if (!kebabFound) {
  // fall back: the kebab IconButton may have a different aria-label; click the last small button in the card
  const candidates = page.locator('[aria-haspopup], button:has(svg)').last();
  kebabFound = await candidates.isVisible().catch(() => false);
}
log('kebab visible:', kebabFound);
try {
  await kebab.click({ timeout: 2000 });
  await page.waitForTimeout(300);
  await shot('03-kebab-menu');
  const menuRole = await page.getByRole('menu').isVisible().catch(() => false);
  const renameItem = await page.getByRole('menuitem', { name: /rename/i }).isVisible().catch(() => false);
  const removeItem = await page.getByRole('menuitem', { name: /remove|delete/i }).isVisible().catch(() => false);
  log('menu open:', menuRole, '| rename item:', renameItem, '| remove item:', removeItem);

  // Click Remove -> expect ConfirmDialog (NOT instant delete)
  if (removeItem) {
    await page.getByRole('menuitem', { name: /remove|delete/i }).click();
    await page.waitForTimeout(300);
    const confirm = await page.getByRole('alertdialog').isVisible().catch(() => false);
    log('ConfirmDialog opened on Remove:', confirm);
    await shot('04-confirm-remove');
    // cancel it
    const cancel = page.getByRole('button', { name: /cancel/i }).first();
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    await page.waitForTimeout(200);
  }

  // Re-open kebab -> Rename
  await kebab.click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(200);
  const rename = page.getByRole('menuitem', { name: /rename/i });
  if (await rename.isVisible().catch(() => false)) {
    await rename.click();
    await page.waitForTimeout(300);
    await shot('05-rename-dialog');
    const renameDialog = await page.getByRole('dialog').isVisible().catch(() => false);
    log('RenameDialog opened:', renameDialog);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
} catch (e) {
  log('kebab interaction error:', e.message);
}

// --- Settings view: the new guardrail knobs ---
const settingsNav = page.getByRole('button', { name: /Settings/ }).first();
if (await settingsNav.isVisible().catch(() => false)) {
  await settingsNav.click();
  await page.waitForTimeout(400);
}
await shot('06-settings');
// hunt for the Models & runs page / Limits knobs
const modelsTab = page.getByRole('button', { name: /models|runs|limits/i }).first();
if (await modelsTab.isVisible().catch(() => false)) {
  await modelsTab.click();
  await page.waitForTimeout(300);
}
await shot('07-settings-models');
const maxTurns = page.getByLabel(/max turns/i).first();
const maxBudget = page.getByLabel(/max budget|budget/i).first();
const turnsFound = await maxTurns.isVisible().catch(() => false);
const budgetFound = await maxBudget.isVisible().catch(() => false);
log('Max turns input:', turnsFound, '| Max budget input:', budgetFound);
if (turnsFound) {
  await maxTurns.fill('150');
  await page.waitForTimeout(150);
  await shot('08-maxturns-set');
}
// model picker present + long ids?
const modelText = await page.locator('body').innerText();
log('mentions Opus/model in settings:', /opus|sonnet|haiku/i.test(modelText));

// --- Board: empty states + new-task sheet ---
const boardNav = page.getByRole('button', { name: /Kanban|Board/ }).first();
if (await boardNav.isVisible().catch(() => false)) {
  await boardNav.click();
  await page.waitForTimeout(400);
}
await shot('09-board');
const newTask = page.getByRole('button', { name: /new task/i }).first();
if (await newTask.isVisible().catch(() => false)) {
  await newTask.click();
  await page.waitForTimeout(400);
  await shot('10-newtask-sheet');
  const sheet = await page.getByRole('dialog', { name: /new task/i }).isVisible().catch(() => false);
  const turnsInSheet = await page.getByLabel(/max turns/i).first().isVisible().catch(() => false);
  log('New-task sheet open:', sheet, '| per-task max-turns field:', turnsInSheet);
  await page.keyboard.press('Escape');
}

// --- Terminal view: render + echo round-trip against the mock bridge ---
// Reload to the clean initial view first: earlier sections navigate to the
// sidebar-less Projects landing, and the Terminal destination lives in the sidebar.
await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
// The nav button's accessible name is "Terminal" + its "L" hint, so match loosely.
const terminalNav = page.getByRole('button', { name: /Terminal/ }).first();
if (await terminalNav.isVisible().catch(() => false)) {
  await terminalNav.click();
  await page.waitForTimeout(500);
}
await shot('11-terminal');
const terminalEmpty = await page
  .getByText(/No terminals open/i)
  .isVisible()
  .catch(() => false);
log('Terminal view renders (empty state):', terminalEmpty);

// Open the new-terminal picker and pick a target (spawns the in-memory echo shell).
const openTerm = page.getByRole('button', { name: /Open a terminal/i }).first();
if (await openTerm.isVisible().catch(() => false)) {
  await openTerm.click();
  await page.waitForTimeout(300);
  await shot('12-terminal-picker');
  // macOS mock → the confined checkbox is present in the picker.
  const confinedBox = await page
    .getByText(/Confined \(writes limited to this folder\)/i)
    .isVisible()
    .catch(() => false);
  log('Confined checkbox visible in picker:', confinedBox);
  // Pick the repo-root target — scoped INSIDE the modal overlay so we don't hit the
  // sidebar's identically-named project button (which the modal backdrop covers).
  const modal = page.locator('[role="presentation"]').last();
  const target = modal.getByRole('button', { name: /nightcore/i }).first();
  try {
    if (await target.isVisible().catch(() => false)) {
      await target.click({ timeout: 4000 });
      await page.waitForTimeout(500);
    }
  } catch (e) {
    log('terminal target pick skipped:', e.message);
  }
}
await shot('13-terminal-open');

// Echo round-trip: type into the xterm's input and confirm the bytes echo back.
let echoOk = false;
const helper = page.locator('.xterm-helper-textarea').first();
if (await helper.isVisible().catch(() => false)) {
  await helper.focus();
  await page.keyboard.type('echo-roundtrip-42');
  await page.waitForTimeout(400);
  const rows = await page
    .locator('.xterm-rows')
    .first()
    .innerText()
    .catch(() => '');
  echoOk = /echo-roundtrip-42/.test(rows);
}
log('Terminal echo round-trip:', echoOk);
await shot('14-terminal-echo');

log('\n=== CONSOLE ERRORS (' + errors.length + ') ===');
errors.slice(0, 25).forEach((e) => console.log('  ✖', e));

await browser.close();
console.log('\nScreenshots in', OUT);
