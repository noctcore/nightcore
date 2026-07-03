// @nightcore/shared — logger, Result, id generators, fs/path helpers.
// Zero runtime deps (node builtins only). The sole cross-package edge is a
// type-only import of `LogLevel` from @nightcore/contracts (the base contract
// layer, rank 1), erased at runtime — so the canonical level set lives in one place.
export * from './ids.js';
export * from './logger.js';
export * from './paths.js';
export * from './result.js';
export * from './which.js';
