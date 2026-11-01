/**
 * `sidekick-shared/codex` — a small Node-only entry for Codex homes, the
 * child-process environment, `auth.json` helpers, credential-store mode,
 * rollout lookup, and the atomic JSON writers those helpers rely on.
 *
 * Loads a handful of modules and no Zod, so a host that only launches or
 * locates Codex does not pay for the full `sidekick-shared/node` surface.
 * Everything here is also exported from the package root and from
 * `sidekick-shared/node`.
 *
 * @module codex
 */

export {
  getSystemCodexHome,
  resolveSidekickCodexHome,
  getCodexExecutionEnv,
  getCodexMonitoringHomes,
  getCodexSessionsDirs,
  getCodexCredentialStoreMode,
  forceFileCredentialStore,
  CODEX_SESSIONS_SUBDIR,
  CODEX_ARCHIVED_SESSIONS_SUBDIR,
} from './codexPaths';
export type { CodexCredentialStoreMode, CodexSessionsDirsOptions } from './codexPaths';

export {
  parseAuthJson as parseCodexAuthJson,
  readAuthIdentityFromRaw as readCodexAuthIdentity,
  readLastRefresh as readCodexLastRefresh,
  readAccessTokenExpiry as readCodexAccessTokenExpiry,
  identitiesMatch as codexIdentitiesMatch,
  codexRefreshFingerprint,
  compareCodexAuthFreshness,
} from './codexAuth';
export type { CodexAuthIdentity, CodexAuthJsonFile } from './codexAuth';

export { findCodexRolloutFile } from './providers/codexRollouts';
export type { FindCodexRolloutFileOptions } from './providers/codexRollouts';

export { atomicWriteJson, atomicWriteJsonSync } from './writers/atomic';

export { parseClaudeAuthStatus, parseCodexLoginStatus } from './authStatus';
export type { ParsedClaudeAuthStatus, ParsedCodexLoginStatus } from './authStatus';

export { codexRolloutOrigin, codexSpawnParentFromSource } from './parsers/codexRolloutOrigin';
export type { CodexRolloutOrigin } from './parsers/codexRolloutOrigin';
