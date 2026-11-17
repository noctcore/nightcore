/*
 * Tools pinned three ways at once: the version a native binary must report,
 * the image a check falls back to (by index digest), and the linux release
 * assets CI installs (by sha256). A different version audits with a different
 * rule set, so a native tool of another version is never used.
 *
 * The pins below are the defaults this package ships. A repo that needs
 * another version passes its own pin to the same functions; moving a default
 * here is a minor release, because a new rule set can turn a green repo red.
 */

/**
 * A linux release asset: an archive and the binary's path inside it (`member`),
 * or, with no `member`, the binary itself. `path` is under https://github.com/,
 * the only origin fetched.
 */
export interface IReleaseArchive {
  readonly path: string;
  readonly sha256: string;
  readonly member?: string;
}

/** x64 is a GitHub runner; arm64 is a local runner (act) on Apple Silicon. */
export type LinuxArch = 'x64' | 'arm64';

/** What `fetchPinned` installs: any tool pinned by version and by the sha256 of its linux assets. */
export interface IPinnedTool {
  readonly name: string;
  readonly version: string;
  readonly versionArgs: readonly string[];
  readonly linux: Readonly<Record<LinuxArch, IReleaseArchive>>;
}

/** A pinned tool that a check runs natively, or through the image of the tool that needs it. */
export type IToolPin = IPinnedTool;

/** A pinned linter: native at the pinned version, else its image by digest. */
export interface ILinterPin extends IPinnedTool {
  /** The image, pinned by index digest. */
  readonly image: string;
  /** Set when the image is published for this platform only (Rosetta or QEMU elsewhere). */
  readonly platform?: string;
  /** Native tools that must also be on PATH at their pinned version. */
  readonly needs: readonly IToolPin[];
}

export const SHELLCHECK: IToolPin = {
  name: 'shellcheck',
  version: '0.11.0',
  versionArgs: ['--version'],
  linux: {
    x64: {
      path: 'koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz',
      sha256: 'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6',
      member: 'shellcheck-v0.11.0/shellcheck',
    },
    arm64: {
      path: 'koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.aarch64.tar.gz',
      sha256: '68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc',
      member: 'shellcheck-v0.11.0/shellcheck',
    },
  },
};

/** zizmor: GitHub Actions security audits. */
export const ZIZMOR: ILinterPin = {
  name: 'zizmor',
  version: '1.30.1',
  versionArgs: ['--version'],
  image:
    'ghcr.io/zizmorcore/zizmor:1.30.1@sha256:a2eb396d886c053073405c7a980f2139ba2248ec172243cfa3841e57196e8101',
  platform: 'linux/amd64',
  needs: [],
  linux: {
    x64: {
      path: 'zizmorcore/zizmor/releases/download/v1.30.1/zizmor-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a',
      member: 'zizmor',
    },
    arm64: {
      path: 'zizmorcore/zizmor/releases/download/v1.30.1/zizmor-aarch64-unknown-linux-gnu.tar.gz',
      sha256: '7ff1dce33bdd18fd2a4affe63bdd47efcccca97b2cec1c1863ec26e9e2647540',
      member: 'zizmor',
    },
  },
};

/**
 * actionlint: workflow syntax, expressions, and every `run:` script through
 * shellcheck. The image bundles shellcheck 0.11.0, so the Docker route needs
 * nothing native.
 */
export const ACTIONLINT: ILinterPin = {
  name: 'actionlint',
  version: '1.7.12',
  versionArgs: ['-version'],
  image:
    'docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667',
  needs: [SHELLCHECK],
  linux: {
    x64: {
      path: 'rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
      sha256: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      member: 'actionlint',
    },
    arm64: {
      path: 'rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_arm64.tar.gz',
      sha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      member: 'actionlint',
    },
  },
};

/** The workflow linters this package knows how to run, by name. */
export type WorkflowLinterId = 'zizmor' | 'actionlint';

export const WORKFLOW_LINTERS: Readonly<Record<WorkflowLinterId, ILinterPin>> = {
  zizmor: ZIZMOR,
  actionlint: ACTIONLINT,
};

/** Every linux asset the workflow linters need on the native route: both linters and shellcheck. */
export const WORKFLOW_LINTER_TOOLS: readonly IToolPin[] = [ZIZMOR, ACTIONLINT, SHELLCHECK];

/**
 * The gitleaks image a secret scan falls back to, by digest. Its tag must name
 * the version CI installs; `chooseGitleaksRoute` refuses it otherwise.
 */
export const GITLEAKS_IMAGE =
  'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
