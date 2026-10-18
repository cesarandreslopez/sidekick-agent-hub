/**
 * Testing entry (`sidekick-shared/testing`): helpers for test suites that
 * exercise sidekick-shared against Claude Code and Codex session data.
 *
 * - `installCredentialGuard()` keeps tests away from the real `security`,
 *   `claude`, and `codex` binaries and the real Claude, Codex, and Sidekick
 *   homes.
 * - The session-log builders write Claude Code and Codex logs in the shapes
 *   the readers parse.
 */
export { installCredentialGuard } from './credentialGuard';
export type { CredentialGuard, CredentialGuardOptions } from './credentialGuard';
export {
  appendJsonl,
  claudeFiller,
  codexFiller,
  createSessionLogFixtures,
  ts,
  writeJsonl,
} from './sessionLogFixtures';
export type { Row, SessionLogFixtureContext } from './sessionLogFixtures';
