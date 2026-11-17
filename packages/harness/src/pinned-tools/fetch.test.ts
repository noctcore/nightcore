import { describe, expect, test } from 'bun:test';

import type { IFetchDeps } from './fetch.js';
import { fetchPinned } from './fetch.js';
import type { IPinnedTool } from './pins.js';
import { ACTIONLINT, SHELLCHECK, WORKFLOW_LINTER_TOOLS, ZIZMOR } from './pins.js';

type Tagged = Uint8Array & { url: string };

const bytes = new Uint8Array([1, 2, 3]);

function fetchDeps(
  digest: (url: string) => string,
  version: (tool: IPinnedTool) => string,
): IFetchDeps {
  return {
    download: (url) => Promise.resolve(Object.assign(new Uint8Array(bytes), { url })),
    sha256: (data) => digest((data as Tagged).url),
    unpack: (_data, member, dir) => `${dir}/${member}`,
    place: (_data, name, dir) => `${dir}/${name}`,
    versionOf: (_binary, tool) => version(tool),
  };
}

function pinnedDigest(url: string): string {
  return (
    WORKFLOW_LINTER_TOOLS.flatMap((tool) => [tool.linux.x64, tool.linux.arm64]).find(
      (archive) => archive.path === url,
    )?.sha256 ?? 'unknown'
  );
}

describe('fetchPinned', () => {
  test('installs every tool whose archive and version match the pins', async () => {
    const installed = await fetchPinned(
      WORKFLOW_LINTER_TOOLS,
      'x64',
      '/bin',
      fetchDeps(pinnedDigest, (tool) => tool.version),
    );
    expect(installed).toEqual(['zizmor 1.30.1', 'actionlint 1.7.12', 'shellcheck 0.11.0']);
  });

  test('downloads the archive of the architecture it runs on', async () => {
    const downloaded: string[] = [];
    const base = fetchDeps(pinnedDigest, (tool) => tool.version);
    await fetchPinned(WORKFLOW_LINTER_TOOLS, 'arm64', '/bin', {
      ...base,
      download: (path) => {
        downloaded.push(path);
        return base.download(path);
      },
    });
    expect(downloaded).toEqual(WORKFLOW_LINTER_TOOLS.map((tool) => tool.linux.arm64.path));
  });

  test('refuses an archive whose sha256 is not the pinned one', async () => {
    const run = fetchPinned(
      [SHELLCHECK],
      'x64',
      '/bin',
      fetchDeps(
        () => 'f'.repeat(64),
        (tool) => tool.version,
      ),
    );
    await expect(run).rejects.toThrow(/shellcheck 0\.11\.0: .* has sha256 f{64}, pinned b7af85e4/u);
  });

  test('verifies the sha256 before it unpacks or runs anything from the archive', async () => {
    const touched: string[] = [];
    const base = fetchDeps(
      () => 'f'.repeat(64),
      (tool) => tool.version,
    );
    const run = fetchPinned([ACTIONLINT], 'x64', '/bin', {
      ...base,
      unpack: (data, member, dir) => {
        touched.push('unpack');
        return base.unpack(data, member, dir);
      },
      versionOf: (binary, tool) => {
        touched.push('versionOf');
        return base.versionOf(binary, tool);
      },
    });
    await expect(run).rejects.toThrow(/has sha256/u);
    expect(touched).toEqual([]);
  });

  test('refuses a binary that reports another version', async () => {
    const run = fetchPinned(
      [ZIZMOR],
      'arm64',
      '/bin',
      fetchDeps(pinnedDigest, () => '1.29.0'),
    );
    await expect(run).rejects.toThrow(/zizmor: the unpacked binary reports 1\.29\.0, pinned 1\.30\.1/u);
  });

  describe('a release asset that is the binary itself, not an archive', () => {
    const BARE: IPinnedTool = {
      name: 'baretool',
      version: '3.2.1',
      versionArgs: ['--version'],
      linux: {
        x64: {
          path: 'owner/baretool/releases/download/v3.2.1/baretool-x64',
          sha256: 'a'.repeat(64),
        },
        arm64: {
          path: 'owner/baretool/releases/download/v3.2.1/baretool-arm64',
          sha256: 'b'.repeat(64),
        },
      },
    };

    function bareDeps(digest: string, touched: string[]): IFetchDeps {
      return {
        ...fetchDeps(
          () => digest,
          (tool) => tool.version,
        ),
        unpack: (_data, member, dir) => {
          touched.push(`unpack ${member}`);
          return `${dir}/${member}`;
        },
        place: (_data, name, dir) => {
          touched.push(`place ${name}`);
          return `${dir}/${name}`;
        },
      };
    }

    test("is placed under the tool's name and never handed to tar", async () => {
      const touched: string[] = [];
      const installed = await fetchPinned([BARE], 'x64', '/bin', bareDeps('a'.repeat(64), touched));
      expect(installed).toEqual(['baretool 3.2.1']);
      expect(touched).toEqual(['place baretool']);
    });

    test('is refused, and never placed, when its sha256 is not the pinned one', async () => {
      const touched: string[] = [];
      const run = fetchPinned([BARE], 'arm64', '/bin', bareDeps('f'.repeat(64), touched));
      await expect(run).rejects.toThrow(
        /baretool 3\.2\.1: .*baretool-arm64 has sha256 f{64}, pinned b{64}/u,
      );
      expect(touched).toEqual([]);
    });

    test('still unpacks an archive, by its member, in the same run', async () => {
      const touched: string[] = [];
      const base = bareDeps('a'.repeat(64), touched);
      await fetchPinned([BARE, SHELLCHECK], 'x64', '/bin', {
        ...base,
        sha256: (data) =>
          (data as Tagged).url === SHELLCHECK.linux.x64.path
            ? SHELLCHECK.linux.x64.sha256
            : 'a'.repeat(64),
      });
      expect(touched).toEqual(['place baretool', 'unpack shellcheck-v0.11.0/shellcheck']);
    });
  });
});
