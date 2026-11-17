/*
 * `@noctcore/harness/pinned-tools`: run a linter at exactly its pinned version,
 * natively or through its image by digest, and install the pinned linux
 * binaries in CI after checking each sha256. Pure functions take their I/O as
 * deps; `nodeRunDeps`, `nodeGitleaksDeps` and `nodeFetchDeps` are the real ones.
 */
export type { IFetchDeps } from './pinned-tools/fetch.js';
export { fetchPinned } from './pinned-tools/fetch.js';
export type {
  GitleaksRoute,
  IGitleaksDeps,
  IGitleaksOptions,
  IGitleaksResult,
  IGitleaksRunDeps,
} from './pinned-tools/gitleaks.js';
export {
  chooseGitleaksRoute,
  GITLEAKS_CONFIG,
  GITLEAKS_VERSION_VARIABLE,
  gitleaksArgs,
  imageVersion,
  pinnedGitleaksVersion,
  runGitleaks,
} from './pinned-tools/gitleaks.js';
export type { INodeFetchOptions } from './pinned-tools/node.js';
export {
  dockerAvailable,
  nodeFetchDeps,
  nodeGitleaksDeps,
  nodeRunDeps,
  workflowFilesUnder,
} from './pinned-tools/node.js';
export type {
  ILinterPin,
  IPinnedTool,
  IReleaseArchive,
  IToolPin,
  LinuxArch,
  WorkflowLinterId,
} from './pinned-tools/pins.js';
export {
  ACTIONLINT,
  GITLEAKS_IMAGE,
  SHELLCHECK,
  WORKFLOW_LINTER_TOOLS,
  WORKFLOW_LINTERS,
  ZIZMOR,
} from './pinned-tools/pins.js';
export type { IPlaceIo } from './pinned-tools/place-binary.js';
export { nodePlaceIo, placeBinary } from './pinned-tools/place-binary.js';
export type {
  ILinterResult,
  IRouteDeps,
  IRunDeps,
  LinterRoute,
  LinterStatus,
} from './pinned-tools/route.js';
export {
  chooseRoute,
  dockerRunArgs,
  exitCodeFor,
  lintArgs,
  linterVerdict,
  parseVersion,
  runLinter,
} from './pinned-tools/route.js';
