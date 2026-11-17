import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { IMetaCtx, IMetaRule, IViolation } from '../lint-meta/types.js';
import { DEFAULT_LOCKFILE } from './pnpm-lockfile.js';

export const PNPM_PATCH_LEDGER_ID = 'pnpm-patch-ledger';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const MANIFEST_FILE = 'package.json';

/**
 * Every patched dependency must say why it is patched, where upstream tracks
 * it, what removes the patch, and when to look at it again.
 *
 * A `patchedDependencies` entry rewrites a package after it is installed. The
 * entry itself carries a file path and nothing else, and a patch nobody
 * remembers the reason for is never removed: it outlives the bug it worked
 * around and quietly stops a dependency from moving. pnpm already fails the
 * install when the patched version moves (ERR_PNPM_UNUSED_PATCH) or a hunk
 * stops applying (ERR_PNPM_PATCH_FAILED); what it cannot know is whether the
 * patch is still needed. The ledger (`patches.ledger.json` by default), keyed by
 * the exact `patchedDependencies` key, carries that, and this rule keeps the
 * ledger load-bearing. It reports:
 *
 *   1. a patch with no ledger entry, and a ledger entry with no patch. The key
 *      holds the version, so a patch moved to another version is a new entry
 *      to justify, not the old one carried over.
 *   2. an entry without a `reason`, an `upstream` link, a `removeWhen`
 *      condition or a `reviewBy`, and a `reviewBy` that is unparseable or in
 *      the past. An entry is due AFTER its day: the rule is green for the
 *      whole of `reviewBy` (by the UTC calendar, so every machine agrees) and
 *      red from the first second of the next day. From then on the run is red
 *      until someone renews the entry with a reason or removes the patch. That
 *      is the design: a date nobody is stopped by is a comment.
 *   3. a key that pins no exact version: the pin is what makes pnpm fail the
 *      install when the dependency moves, instead of patching whatever arrived
 *   4. a patch file that does not exist, or that is declared at one path and
 *      locked at another
 *   5. a lockfile whose patch hash is not the hash of the patch file, or that
 *      does not record the patch at all: the file changed and nothing was
 *      installed since
 *
 * The ledger may describe itself in one `$comment` string, which is not an
 * entry; every other key is one.
 *
 * Dormant by design: with no patched dependency and no ledger the rule returns
 * []. Both places pnpm reads the setting from are read (`pnpm-workspace.yaml`
 * and the root manifest's `pnpm.patchedDependencies`), textually, and a block
 * this cannot read is reported instead of skipped.
 */
export interface IPnpmPatchLedgerOptions {
  /** The ledger file, relative to the repo root. Default `patches.ledger.json`. */
  readonly ledger?: string;
  /** The lockfile, relative to the repo root. Default `pnpm-lock.yaml`. */
  readonly lockfile?: string;
  /** The clock the `reviewBy` dates are judged against. Default `() => new Date()`. */
  readonly now?: () => Date;
}

interface ILedgerEntry {
  readonly reason: string;
  readonly upstream: string;
  readonly removeWhen: string;
  readonly reviewBy: string;
}

const DEFAULT_LEDGER = 'patches.ledger.json';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** The one key of the ledger that is not a patch: a description of the file, for whoever opens it. */
const COMMENT_KEY = '$comment';
/** `name@1.2.3`, with an optional scope: an exact version, no range. */
const EXACT_KEY = /^(?:@[^@/\s]+\/)?[^@/\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;
/** A `key: value` line two spaces deep; the key bare or in either kind of quotes. */
const ENTRY_LINE = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s:#][^:]*)):\s*(.*)$/u;

function violation(file: string, message: string): IViolation {
  return { file, rule: PNPM_PATCH_LEDGER_ID, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/u, '$2');
}

/** The lines of a top-level YAML block, without blank lines and comments, or null when there is none. */
function topLevelBlock(text: string, name: string): { inline: string; lines: string[] } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (start === -1) {
    return null;
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line) && !line.startsWith('#')) {
      break;
    }
    if (line.trim() !== '' && !line.trim().startsWith('#')) {
      body.push(line);
    }
  }
  const inline = (lines[start] ?? '').slice(name.length + 1).trim();
  return { inline: inline.startsWith('#') ? '' : inline, lines: body };
}

interface IDeclaredPatches {
  /** Patch file per `patchedDependencies` key, as declared. */
  readonly patches: Map<string, string>;
  readonly unreadable: IViolation[];
}

/**
 * Every declared patch: the `patchedDependencies` block of pnpm-workspace.yaml
 * and the root manifest's `pnpm.patchedDependencies`. Null when neither exists.
 */
export function readPatchedDependencies(ctx: IMetaCtx): IDeclaredPatches | null {
  const patches = new Map<string, string>();
  const unreadable: IViolation[] = [];
  let declared = false;

  const workspace = ctx.read(WORKSPACE_FILE);
  const block = workspace === null ? null : topLevelBlock(workspace, 'patchedDependencies');
  if (block !== null) {
    declared = true;
    if (block.inline !== '' && block.inline !== '{}') {
      unreadable.push(
        violation(
          WORKSPACE_FILE,
          `\`patchedDependencies\` is written on one line ("${block.inline}"), which this rule cannot read. Write one \`'name@version': path\` entry per line.`,
        ),
      );
    }
    for (const line of block.lines) {
      const match = ENTRY_LINE.exec(line);
      const key = match?.[1] ?? match?.[2] ?? match?.[3];
      const value = match?.[4];
      if (key === undefined || value === undefined || unquote(value) === '') {
        unreadable.push(
          violation(
            WORKSPACE_FILE,
            `\`patchedDependencies\` holds a line this rule cannot read ("${line.trim()}"). Write one \`'name@version': path\` entry per line.`,
          ),
        );
        continue;
      }
      patches.set(key.trim(), unquote(value));
    }
  }

  const manifestPatches = asRecord(
    asRecord(asRecord(parseJson(ctx.read(MANIFEST_FILE)))?.['pnpm'])?.['patchedDependencies'],
  );
  if (manifestPatches !== null) {
    declared = true;
    for (const [key, value] of Object.entries(manifestPatches)) {
      if (typeof value === 'string') {
        patches.set(key, value);
      }
    }
  }

  return declared ? { patches, unreadable } : null;
}

interface ILockedPatch {
  readonly hash: string | null;
  readonly path: string | null;
}

/** The lockfile's `patchedDependencies` block: hash and path per key. Null without a lockfile. */
export function readLockfilePatches(
  ctx: IMetaCtx,
  lockfilePath: string = DEFAULT_LOCKFILE,
): Map<string, ILockedPatch> | null {
  const lockfile = ctx.read(lockfilePath);
  if (lockfile === null) {
    return null;
  }
  const out = new Map<string, ILockedPatch>();
  const block = topLevelBlock(lockfile, 'patchedDependencies');
  let current: string | null = null;
  for (const line of block?.lines ?? []) {
    const key = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s:][^:]*)):\s*$/u.exec(line);
    const name = key?.[1] ?? key?.[2] ?? key?.[3];
    if (name !== undefined) {
      current = name.trim();
      out.set(current, { hash: null, path: null });
      continue;
    }
    const field = /^ {4}(hash|path):\s*(.+)$/u.exec(line);
    const entry = current === null ? undefined : out.get(current);
    if (field === null || current === null || entry === undefined) {
      continue;
    }
    out.set(current, {
      ...entry,
      [field[1] === 'hash' ? 'hash' : 'path']: unquote(field[2] ?? ''),
    });
  }
  return out;
}

/** pnpm's patch hash: sha256 of the patch file with CRLF line ends read as LF. */
export function patchFileHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/gu, '\n')).digest('hex');
}

/** A parsed ledger entry, or the reason it is not one. */
function parseEntry(raw: unknown): { entry: ILedgerEntry } | { error: string } {
  const record = asRecord(raw);
  if (record === null) {
    return { error: 'the entry is not an object' };
  }
  const text = (field: string): string | null => {
    const value = record[field];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };

  const reason = text('reason');
  if (reason === null) {
    return { error: '`reason` must be a non-empty string: what breaks without the patch' };
  }
  const upstream = text('upstream');
  if (upstream === null || !/^https:\/\/\S+$/u.test(upstream)) {
    return {
      error:
        '`upstream` must be an https link to the issue or pull request that tracks the defect upstream',
    };
  }
  const removeWhen = text('removeWhen');
  if (removeWhen === null) {
    return {
      error: '`removeWhen` must be a non-empty string: the condition under which the patch goes',
    };
  }
  const reviewBy = record['reviewBy'];
  if (typeof reviewBy !== 'string') {
    return { error: '`reviewBy` is missing. An undated patch is never looked at again' };
  }
  return { entry: { reason, upstream, removeWhen, reviewBy } };
}

function checkReviewBy(ledgerPath: string, key: string, entry: ILedgerEntry, today: Date): IViolation[] {
  const { reviewBy } = entry;
  if (!ISO_DATE.test(reviewBy)) {
    return [
      violation(
        ledgerPath,
        `\`${key}\` has \`reviewBy: "${reviewBy}"\`, which is not a yyyy-MM-dd date. An undated patch is never looked at again.`,
      ),
    ];
  }
  const due = new Date(`${reviewBy}T00:00:00Z`);
  // `new Date('2026-02-31T00:00:00Z')` is March 3, not an invalid date.
  if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== reviewBy) {
    return [
      violation(ledgerPath, `\`${key}\` has \`reviewBy: "${reviewBy}"\`, which is not a real date.`),
    ];
  }
  // Calendar dates, both in UTC, compared as text: the entry is due after its
  // day, not from the midnight that begins it.
  if (today.toISOString().slice(0, 10) <= reviewBy) {
    return [];
  }
  return [
    violation(
      ledgerPath,
      `\`${key}\` was due for review on ${reviewBy}. Check ${entry.upstream} against its \`removeWhen\`, then remove the patch or move the date forward with a reason.`,
    ),
  ];
}

/** The raw patch file (not LF-normalized beyond what pnpm does), or null when it is missing. */
function readPatchFile(root: string, rel: string): string | null {
  const abs = path.join(root, ...rel.split('/'));
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

function checkPatchFile(
  ctx: IMetaCtx,
  lockfilePath: string,
  key: string,
  patchPath: string,
  locked: Map<string, ILockedPatch> | null,
): IViolation[] {
  const patch = readPatchFile(ctx.root, patchPath);
  if (patch === null) {
    return [
      violation(
        patchPath,
        `\`${key}\` is patched with ${patchPath}, which does not exist. Restore the patch file, or remove the \`patchedDependencies\` entry and its ledger entry.`,
      ),
    ];
  }
  if (locked === null) {
    return [];
  }
  const lock = locked.get(key);
  if (lock === undefined) {
    return [
      violation(
        lockfilePath,
        `\`${key}\` is patched but ${lockfilePath} does not record the patch. Run \`pnpm install\` so the lockfile carries the patch that is declared.`,
      ),
    ];
  }
  const violations: IViolation[] = [];
  if (lock.path !== patchPath) {
    violations.push(
      violation(
        lockfilePath,
        `\`${key}\` is patched with ${patchPath} but ${lockfilePath} locks ${lock.path ?? 'no path'}. Run \`pnpm install\` so both name the same patch file.`,
      ),
    );
  }
  const hash = patchFileHash(patch);
  if (lock.hash !== hash) {
    violations.push(
      violation(
        lockfilePath,
        `\`${key}\`: ${patchPath} hashes to ${hash.slice(0, 12)} but ${lockfilePath} locks ${lock.hash?.slice(0, 12) ?? 'no hash'}. The patch file changed since the last install: run \`pnpm install\`, and re-read the ledger entry against the new patch.`,
      ),
    );
  }
  return violations;
}

/** Every finding of the patch ledger rule for the repo `ctx` reads, judged at `today`. */
export function checkPnpmPatchLedger(
  ctx: IMetaCtx,
  today: Date,
  options: Pick<IPnpmPatchLedgerOptions, 'ledger' | 'lockfile'> = {},
): IViolation[] {
  const ledgerPath = options.ledger ?? DEFAULT_LEDGER;
  const lockfilePath = options.lockfile ?? DEFAULT_LOCKFILE;
  const declared = readPatchedDependencies(ctx);
  const ledgerText = ctx.read(ledgerPath);

  if (declared === null && ledgerText === null) {
    return [];
  }
  const patches = declared?.patches ?? new Map<string, string>();
  const violations: IViolation[] = [...(declared?.unreadable ?? [])];

  if (ledgerText === null) {
    if (patches.size === 0) {
      return violations;
    }
    return [
      ...violations,
      violation(
        ledgerPath,
        `\`patchedDependencies\` patches ${[...patches.keys()].join(', ')} but ${ledgerPath} does not exist. Every patch needs a reason, an upstream link, a removal condition and a review date.`,
      ),
    ];
  }

  const ledger = asRecord(parseJson(ledgerText));
  if (ledger === null) {
    return [
      ...violations,
      violation(ledgerPath, `${ledgerPath} is not a JSON object keyed by \`patchedDependencies\` key.`),
    ];
  }

  const comment = ledger[COMMENT_KEY];
  if (comment !== undefined && typeof comment !== 'string') {
    violations.push(
      violation(
        ledgerPath,
        `\`${COMMENT_KEY}\` must be a string: it describes the ledger and is the one key that is not a patch.`,
      ),
    );
  }

  for (const key of Object.keys(ledger)) {
    if (key === COMMENT_KEY) continue;
    if (!patches.has(key)) {
      violations.push(
        violation(
          ledgerPath,
          `\`${key}\` has a ledger entry but no matching \`patchedDependencies\` key. Delete the entry, or, if the patch moved to another version, write the entry for that version.`,
        ),
      );
    }
  }

  const locked = readLockfilePatches(ctx, lockfilePath);
  for (const [key, patchPath] of patches) {
    if (!EXACT_KEY.test(key)) {
      violations.push(
        violation(
          WORKSPACE_FILE,
          `\`${key}\` does not pin an exact version. Write \`name@x.y.z\`, so pnpm fails the install when the dependency moves instead of patching whatever arrived.`,
        ),
      );
    }

    const raw = ledger[key];
    if (raw === undefined) {
      violations.push(
        violation(
          ledgerPath,
          `\`${key}\` is patched with ${patchPath} and has no ledger entry. Add one with \`reason\`, \`upstream\`, \`removeWhen\` and \`reviewBy\`.`,
        ),
      );
    } else {
      const parsed = parseEntry(raw);
      if ('error' in parsed) {
        violations.push(violation(ledgerPath, `\`${key}\`: ${parsed.error}.`));
      } else {
        violations.push(...checkReviewBy(ledgerPath, key, parsed.entry, today));
      }
    }

    violations.push(...checkPatchFile(ctx, lockfilePath, key, patchPath, locked));
  }

  return violations;
}

/** Every patched dependency carries a dated ledger entry that the patch file and the lockfile agree with. */
export function createPnpmPatchLedgerRule(options: IPnpmPatchLedgerOptions = {}): IMetaRule {
  const ledgerPath = options.ledger ?? DEFAULT_LEDGER;
  const now = options.now ?? (() => new Date());
  return {
    id: PNPM_PATCH_LEDGER_ID,
    category: 'supply-chain',
    ciCritical: true,
    description: `Every patchedDependencies entry needs a ${ledgerPath} entry with a reason, an upstream link, a removal condition and a reviewBy that has not passed (red from the day after it, until the entry is renewed or the patch removed), must pin an exact version, and its patch file must exist and hash to what the lockfile records.`,
    run(ctx: IMetaCtx): IViolation[] {
      return checkPnpmPatchLedger(ctx, now(), options);
    },
  };
}
