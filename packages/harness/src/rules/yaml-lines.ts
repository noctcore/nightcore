/**
 * Line helpers for the rules that read YAML (pnpm's workspace file and lockfile,
 * GitHub Actions workflows) without a YAML parser. The package has zero runtime
 * dependencies, so these rules read the few shapes they need line by line and
 * report a line they cannot read instead of skipping it.
 */

/** A YAML line with its trailing comment removed (a `#` at the start or after whitespace). */
export function stripYamlComment(line: string): string {
  return line.replace(/(^|\s)#.*$/u, '');
}

/** A YAML scalar with surrounding quotes removed. */
export function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/u, '$2');
}

/** The number of leading whitespace characters of a line. */
export function indentOf(line: string): number {
  return (/^(\s*)/u.exec(line)?.[1] ?? '').length;
}

/** A run of lines, as 0-based indexes: `start` is the first line inside, `end` is one past the last. */
export interface ILineBlock {
  readonly start: number;
  readonly end: number;
}

/** The lines under the key on `keyIndex` that are indented deeper than it (blank lines included). */
export function blockUnder(lines: readonly string[], keyIndex: number): ILineBlock {
  const keyIndent = indentOf(lines[keyIndex] ?? '');
  let end = keyIndex + 1;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    if (indentOf(line) <= keyIndent) break;
    end = index + 1;
  }
  return { start: keyIndex + 1, end };
}
