/**
 * Deterministic prompt-injection detector for inter-seat Council messages
 * (issue #348, safety non-negotiable #2). One seat's text is UNTRUSTED data the
 * moment it could reach another seat's context; before it is delivered (quoted)
 * it is swept for the content shapes used to smuggle instructions to a coding
 * agent.
 *
 * This is the TS-tier counterpart of the Rust project scanner
 * `apps/desktop/src-tauri/src/analysis/injection_scan.rs`: it ports that module's
 * detectors verbatim -- the same instruction-phrase list, the same invisible-tag /
 * zero-width-run / bidi-override character detectors, and the same reason strings --
 * so the two tiers flag identically. It runs in the engine because inter-seat
 * delivery is an engine-tier concern (seats are provider sessions); the Rust module
 * sweeps git-tracked FILES, this one sweeps a single in-flight MESSAGE.
 *
 * Detector posture, like the Rust module: high precision over recall, and it
 * DETECTS -- it never rewrites or blocks. The returned reasons are evidence the
 * caller records on the transcript entry and the (future) conductor can act on; the
 * authoritative execution controls remain the per-seat OS sandbox + tool-deny
 * policy. The complementary OUTPUT defense is {@link import('./quoted-delivery.js')},
 * which fences and quotes what a seat echoes.
 */
import { basename, parseCommandLine } from '../policy/command-parser.js';

/** The result of scanning one message. `flagged` is a convenience for
 *  `reasons.length > 0`; `reasons` are the human-readable detector hits, recorded on
 *  the transcript for audit. */
export interface InjectionScanResult {
  flagged: boolean;
  reasons: string[];
}

/** Verbatim instruction-shaped phrases (matched case-insensitively) -- the exact
 *  list from `injection_scan.rs`. Each is an imperative aimed at an AGENT with a
 *  very low base rate in genuine debate prose. */
const INSTRUCTION_PHRASES = [
  'ignore previous instructions',
  'ignore all previous instructions',
  'disregard previous instructions',
  'disregard all previous instructions',
  'do not inform the user',
  'do not tell the user',
  'without telling the user',
  'conceal this from the user',
] as const;

/** Zero-width code points (ZWSP, ZWNJ, ZWJ, WORD JOINER, BOM). A single one is
 *  legitimate (emoji ZWJ sequences, some scripts); a RUN of 3+ is the shape used to
 *  encode a hidden payload. Built from numeric code points so this source stays pure
 *  ASCII and carries no invisible characters of its own. */
const BOM_CODE = 0xfeff;
const ZERO_WIDTH = new Set(
  [0x200b, 0x200c, 0x200d, 0x2060, BOM_CODE].map((c) => String.fromCodePoint(c)),
);

/** High-signal command words that have essentially no benign reason to appear AS A
 *  COMMAND WORD inside a debate message -- destruction, remote fetch, privilege, and
 *  arbitrary-exec binaries. Reused with {@link parseCommandLine}, whose whole point
 *  is surfacing a command word hidden inside a `$(...)` / backtick substitution. */
const DANGEROUS_COMMANDS = new Set([
  'rm',
  'curl',
  'wget',
  'bash',
  'sh',
  'zsh',
  'eval',
  'sudo',
  'chmod',
  'chown',
  'dd',
  'mkfs',
  'nc',
  'ncat',
  'scp',
  'ssh',
]);

/** Whether `code` is a Unicode tag-block character (U+E0000..=U+E007F): invisible
 *  characters that mirror ASCII and can encode a full hidden prompt. */
function isUnicodeTag(code: number): boolean {
  return code >= 0xe0000 && code <= 0xe007f;
}

/** Whether `code` is a bidi override/isolate control (U+202A..=U+202E,
 *  U+2066..=U+2069): the trojan-source vector (renders unlike it parses). */
function isBidiOverride(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Latch the three character-shape detectors in a single pass over the code points.
 *  A BOM at position 0 is tooling residue: it neither counts toward a zero-width run
 *  nor resets one (mirrors the Rust `is_bom` carve-out). */
function scanCharacterShapes(text: string): string[] {
  const reasons: string[] = [];
  let unicodeTags = false;
  let bidiOverrides = false;
  let zeroWidthRun = false;
  let run = 0;
  let index = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (!unicodeTags && isUnicodeTag(code)) unicodeTags = true;
    if (!bidiOverrides && isBidiOverride(code)) bidiOverrides = true;
    const isBom = index === 0 && code === BOM_CODE;
    if (!zeroWidthRun && !isBom) {
      if (ZERO_WIDTH.has(ch)) {
        run += 1;
        if (run >= 3) zeroWidthRun = true;
      } else {
        run = 0;
      }
    }
    index += 1;
  }
  if (unicodeTags) {
    reasons.push('invisible Unicode tag characters (hidden-prompt vector)');
  }
  if (zeroWidthRun) {
    reasons.push('zero-width character run (hidden-payload vector)');
  }
  if (bidiOverrides) {
    reasons.push('bidi override characters (trojan-source vector)');
  }
  return reasons;
}

/** The instruction-shaped phrases present in `text` (ASCII case-insensitive). */
function instructionPhrases(text: string): string[] {
  const haystack = text.toLowerCase();
  return INSTRUCTION_PHRASES.filter((p) => haystack.includes(p)).map(
    (phrase) => `instruction-shaped phrase: "${phrase}"`,
  );
}

/** Dangerous command words surfaced when `text` is read as a shell line -- including
 *  words hidden inside `$(...)` / backtick substitutions, which {@link parseCommandLine}
 *  unwraps. Only the command WORD (first token of each simple command) is checked, so
 *  a benign argument that merely contains a binary name never fires. */
function shellCommandWords(text: string): string[] {
  const seen = new Set<string>();
  for (const command of parseCommandLine(text)) {
    const first = command[0];
    if (first === undefined) continue;
    const word = basename(first);
    if (DANGEROUS_COMMANDS.has(word)) seen.add(word);
  }
  return [...seen].map((word) => `shell command word in untrusted text: "${word}"`);
}

/**
 * Scan one inter-seat message for injection payloads. Pure and filesystem-free --
 * unit-tested directly. Returns every detector hit; the caller records them on the
 * transcript and delivers the message QUOTED regardless (detection, not blocking).
 */
export function scanForInjection(text: string): InjectionScanResult {
  const reasons = [
    ...scanCharacterShapes(text),
    ...instructionPhrases(text),
    ...shellCommandWords(text),
  ];
  return { flagged: reasons.length > 0, reasons };
}
