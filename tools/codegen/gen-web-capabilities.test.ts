/**
 * Canaries for the engine → web capability generator (issue #158).
 *
 * The generator's job is to make the web's synchronous Claude default impossible to
 * drift from the engine descriptor. These tests pin the two ways that job can quietly
 * fail: emitting something the web can't consume, and emitting something WRONG for a
 * field shape the renderer doesn't actually understand.
 */
import { describe, expect, it } from 'bun:test';

import type { ProviderCapabilities } from '@nightcore/contracts';

import { CLAUDE_CAPABILITIES } from '../../packages/engine/src/providers/claude/capabilities';
import { emit } from './gen-web-capabilities';

describe('gen-web-capabilities', () => {
  it('emits every field of the engine descriptor', () => {
    const source = emit(CLAUDE_CAPABILITIES);
    for (const key of Object.keys(CLAUDE_CAPABILITIES)) {
      expect(source).toContain(`${key}:`);
    }
  });

  it('emits values that round-trip back to the descriptor', () => {
    // Parse the emitted object literal back out and compare to the source of truth —
    // catches a renderer that emits syntactically valid but semantically wrong TS
    // (the `[object Object]` class of bug), which a substring check would miss.
    const source = emit(CLAUDE_CAPABILITIES);
    const literal = source.slice(
      source.indexOf('= {') + 2,
      source.lastIndexOf('};') + 1,
    );
    const parsed = new Function(`return ${literal}`)() as ProviderCapabilities;
    expect(parsed).toEqual(CLAUDE_CAPABILITIES);
  });

  it('marks the output as generated so it is not hand-edited', () => {
    expect(emit(CLAUDE_CAPABILITIES)).toContain('@generated');
  });

  it('imports only a type, never the engine', () => {
    // The whole reason this is codegen rather than an import: `apps/web` may not
    // depend on `packages/engine`. If the emitter ever grows a value import, the
    // generated file would create exactly the layer violation this design avoids.
    //
    // Assert over the IMPORT STATEMENTS only — the header comment names the engine
    // descriptor on purpose, as the source-of-truth pointer a reader needs.
    const imports = emit(CLAUDE_CAPABILITIES)
      .split('\n')
      .filter((line) => line.startsWith('import'));

    expect(imports).toEqual([
      "import type { ProviderCapabilities } from '@nightcore/contracts';",
    ]);
  });

  it('fails loud on a value shape it cannot render', () => {
    // A future non-flat field (nested object, number) must red the generator rather
    // than stringify wrong into the web tree.
    const nested = {
      ...CLAUDE_CAPABILITIES,
      nestedLimits: { maxTurns: 10 },
    } as unknown as ProviderCapabilities;
    expect(() => emit(nested)).toThrow(/unsupported value shape/);
  });
});
