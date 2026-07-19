/**
 * @fileoverview One-time migration of legacy raw-slug project stores.
 *
 * 0.23.0 switched all readers and writers to the canonical
 * (symlink-resolved) project slug. Workspaces whose literal path differs
 * from its realpath still hold pre-0.23 data under the legacy raw slug;
 * this helper copies those stores to the canonical slug so they stay
 * visible without any manual merge.
 *
 * @module projectMigration
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  getConfigDir,
  getProjectDataPath,
  resolveProjectIdentity,
  type ProjectIdentity,
} from './paths';

/** Project-scoped JSON store subdomains shared by the extension and CLI. */
const PROJECT_STORE_SUBDOMAINS = [
  'tasks',
  'decisions',
  'notifications',
  'knowledge-notes',
  'plans',
] as const;

/**
 * Copies legacy raw-slug project stores to the canonical slug, once.
 *
 * Only copies when the canonical file does not exist yet, so it can never
 * overwrite newer data; the legacy file is kept as a read-only fallback.
 * Best-effort per store — a failed copy leaves that store on the legacy
 * read path.
 *
 * @returns The canonical paths that were created (empty when none).
 */
export function migrateLegacyProjectStores(cwdOrIdentity: string | ProjectIdentity): string[] {
  const identity =
    typeof cwdOrIdentity === 'string' ? resolveProjectIdentity(cwdOrIdentity) : cwdOrIdentity;
  if (!identity.hasLegacyMismatch) return [];

  const pairs: Array<[legacyPath: string, canonicalPath: string]> = PROJECT_STORE_SUBDOMAINS.map(
    (subdomain) => [
      getProjectDataPath(identity.legacySlug, subdomain),
      getProjectDataPath(identity.canonicalSlug, subdomain),
    ],
  );
  pairs.push([
    path.join(getConfigDir(), 'handoffs', `${identity.legacySlug}-latest.md`),
    path.join(getConfigDir(), 'handoffs', `${identity.canonicalSlug}-latest.md`),
  ]);

  const migrated: string[] = [];
  for (const [legacyPath, canonicalPath] of pairs) {
    try {
      if (!fs.existsSync(legacyPath) || fs.existsSync(canonicalPath)) continue;
      fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
      fs.copyFileSync(legacyPath, canonicalPath, fs.constants.COPYFILE_EXCL);
      migrated.push(canonicalPath);
    } catch {
      // Best effort: an unmigrated store falls back to the legacy read path.
    }
  }
  return migrated;
}
