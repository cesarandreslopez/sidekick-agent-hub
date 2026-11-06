/**
 * The homes a session reader monitors: `resolveAgentHomes()` plus, for
 * Codex, sidekick account-profile homes that recorded sessions.
 *
 * Kept apart from `codexPaths` so the lean `sidekick-shared/codex` entry
 * does not load the home-resolution module it never uses.
 *
 * @module monitoredHomes
 */

import * as path from 'path';
import { resolveAgentHomes, type ResolvedAgentHomes, type SessionHomesOptions } from './agentHomes';
import { dedupePaths, getCodexProfileHomesWithSessions } from './codexPaths';

/**
 * `resolveAgentHomes()` plus, for Codex, the sidekick profile homes that
 * recorded sessions: only when `codexHomes` is omitted and `CODEX_HOME` is
 * unset (or ignored as relative), and unless `includeProfileHomes` is false.
 * Reads the account registry; throws `RangeError` for invalid explicit lists.
 */
export function resolveMonitoredHomes(options: SessionHomesOptions = {}): ResolvedAgentHomes {
  const resolved = resolveAgentHomes(options);
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim();
  const codexFromDefault =
    options.codexHomes === undefined && !(codexHome && path.isAbsolute(codexHome));
  if (codexFromDefault && options.includeProfileHomes !== false) {
    resolved.codex = dedupePaths([...resolved.codex, ...getCodexProfileHomesWithSessions()]);
  }
  return resolved;
}
