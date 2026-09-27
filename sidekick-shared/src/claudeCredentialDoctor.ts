/**
 * Inspect and repair the Claude credential stores Sidekick owns.
 *
 * Ownership is proven, never guessed: a store counts only when its directory
 * is in the ledger (claudeCredentialLedger.ts), is a profile home under
 * Sidekick's accounts directory, or its Keychain item carries Sidekick's
 * comment tag naming the directory. Other tools legitimately create
 * `Claude Code-credentials-<hash>` items for their own `CLAUDE_CONFIG_DIR`, so
 * nothing is ever matched by name pattern.
 *
 * Findings:
 * - `orphan`: the store's directory is gone, or it belongs to no saved account
 *   and no login younger than a day. It holds a copy of some login nothing
 *   will use; repair deletes it.
 * - `live-duplicate`: the live account's profile home holds a CLI-usable copy
 *   of its login (a second copy of the live chain); repair runs the sync that
 *   removes it (repairing live first when the copy is newer).
 * - `corrupt`: the store does not parse (for example a credential truncated by
 *   an older build's Keychain write); repair deletes it, and the account needs
 *   a new sign-in unless its backup is still good.
 * - `stale-entry`: a ledger entry whose store is already gone; repair forgets it.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { listSavedAccountProfiles, type SavedAccountProfile } from './accountRegistry';
import {
  claudeKeychainService,
  getClaudeProfileDir,
  getClaudeProfileHome,
  getClaudeProfilesDir,
  readLiveClaudeIdentity,
} from './claudeProfiles';
import { forgetClaudeCredentialHome, readClaudeCredentialLedger } from './claudeCredentialLedger';
import {
  deleteStoredCredentials,
  readClaudeCredentialStore,
  SIDEKICK_KEYCHAIN_COMMENT_PREFIX,
} from './credentialIO';
import { syncClaudeLiveState } from './accounts';
import type { ProviderSyncReport } from './accountSyncTypes';

export type ClaudeCredentialFindingKind = 'orphan' | 'live-duplicate' | 'corrupt' | 'stale-entry';

export interface ClaudeCredentialFinding {
  kind: ClaudeCredentialFindingKind;
  configDir: string;
  service: string;
  /** How Sidekick knows it owns this store. */
  ownership: 'ledger' | 'profile-home' | 'keychain-tag';
  accountId?: string;
  email?: string;
  detail: string;
  /** What repair does about it. */
  action: string;
}

/** Attributes of one Keychain item (never its secret). */
export interface KeychainItemSummary {
  service: string;
  comment?: string;
}

export interface InspectClaudeCredentialStoresOptions {
  now?: number;
  /**
   * Enumerate `Claude Code-credentials-*` Keychain items, attributes only.
   * Default on macOS: `security dump-keychain` (no `-d`, so no secret is read
   * and nothing prompts). Elsewhere there is no Keychain to scan.
   */
  listKeychainItems?: () => KeychainItemSummary[];
}

export interface ClaudeCredentialInspection {
  findings: ClaudeCredentialFinding[];
  homesChecked: number;
  keychainScanned: boolean;
}

export interface ClaudeCredentialRepairOutcome {
  finding: ClaudeCredentialFinding;
  ok: boolean;
  error?: string;
}

export interface ClaudeCredentialRepairResult extends ClaudeCredentialInspection {
  dryRun: boolean;
  repaired: ClaudeCredentialRepairOutcome[];
  sync?: ProviderSyncReport;
}

/** Logins younger than this may still be finalized; the doctor leaves them alone. */
const PENDING_LOGIN_GRACE_MS = 24 * 60 * 60 * 1000;

function decodeKeychainValue(raw: string): string {
  const quoted = raw.match(/^"(.*)"$/);
  if (quoted) return quoted[1];
  const hex = raw.match(/^0x([0-9A-Fa-f]+)/);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8').replace(/\0+$/, '');
  return raw;
}

/** Parse `security dump-keychain` output (attributes only) into item summaries. */
export function parseKeychainDump(output: string): KeychainItemSummary[] {
  const items: KeychainItemSummary[] = [];
  for (const block of output.split(/^keychain: /m)) {
    const service = block.match(/^\s*"svce"<blob>=(.+)$/m)?.[1];
    if (!service) continue;
    const comment = block.match(/^\s*"icmt"<blob>=(.+)$/m)?.[1];
    const decodedService = decodeKeychainValue(service.trim());
    const decodedComment =
      comment && comment.trim() !== '<NULL>' ? decodeKeychainValue(comment.trim()) : undefined;
    items.push({ service: decodedService, comment: decodedComment });
  }
  return items;
}

function defaultListKeychainItems(): KeychainItemSummary[] {
  if (process.platform !== 'darwin') return [];
  const output = execFileSync('security', ['dump-keychain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseKeychainDump(String(output)).filter((item) =>
    item.service.startsWith('Claude Code-credentials-'),
  );
}

interface OwnedHome {
  configDir: string;
  service: string;
  ownership: ClaudeCredentialFinding['ownership'];
  inLedger: boolean;
}

function collectOwnedHomes(keychainItems: KeychainItemSummary[]): OwnedHome[] {
  const homes = new Map<string, OwnedHome>();
  const add = (configDir: string, ownership: OwnedHome['ownership'], inLedger = false): void => {
    const resolved = path.resolve(configDir);
    const existing = homes.get(resolved);
    if (existing) {
      existing.inLedger ||= inLedger;
      return;
    }
    homes.set(resolved, {
      configDir: resolved,
      service: claudeKeychainService(resolved),
      ownership,
      inLedger,
    });
  };

  for (const entry of readClaudeCredentialLedger()) add(entry.configDir, 'ledger', true);
  try {
    for (const id of fs.readdirSync(getClaudeProfilesDir())) {
      add(getClaudeProfileHome(id), 'profile-home');
    }
  } catch {
    /* no profiles yet */
  }
  for (const item of keychainItems) {
    if (!item.comment?.startsWith(SIDEKICK_KEYCHAIN_COMMENT_PREFIX)) continue;
    const configDir = item.comment.slice(SIDEKICK_KEYCHAIN_COMMENT_PREFIX.length);
    // The tag must name the directory the service was derived from.
    if (configDir && claudeKeychainService(configDir) === item.service) {
      add(configDir, 'keychain-tag');
    }
  }
  return [...homes.values()];
}

function isRecentPendingLogin(configDir: string, now: number): boolean {
  const profilesDir = path.resolve(getClaudeProfilesDir());
  const loginDir = path.dirname(configDir);
  if (path.dirname(loginDir) !== profilesDir) return false;
  try {
    const pending = JSON.parse(
      fs.readFileSync(
        path.join(getClaudeProfileDir(path.basename(loginDir)), 'profile.json'),
        'utf8',
      ),
    ) as { addedAt?: string };
    const addedAt = pending.addedAt ? Date.parse(pending.addedAt) : NaN;
    return !Number.isNaN(addedAt) && now - addedAt < PENDING_LOGIN_GRACE_MS;
  } catch {
    return false;
  }
}

export function inspectClaudeCredentialStores(
  options: InspectClaudeCredentialStoresOptions = {},
): ClaudeCredentialInspection {
  const now = options.now ?? Date.now();
  let keychainItems: KeychainItemSummary[] = [];
  let keychainScanned = false;
  try {
    keychainItems = (options.listKeychainItems ?? defaultListKeychainItems)();
    keychainScanned = Boolean(options.listKeychainItems) || process.platform === 'darwin';
  } catch {
    keychainScanned = false;
  }

  const profilesByHome = new Map<string, SavedAccountProfile>();
  for (const profile of listSavedAccountProfiles('claude-code')) {
    profilesByHome.set(
      path.resolve(getClaudeProfileHome(profile.providerAccountId ?? profile.id)),
      profile,
    );
  }
  const liveUuid = readLiveClaudeIdentity()?.uuid ?? null;
  const findings: ClaudeCredentialFinding[] = [];
  const homes = collectOwnedHomes(keychainItems);

  for (const home of homes) {
    const store = readClaudeCredentialStore(home.configDir);
    if (store.status === 'error') continue;
    const profile = profilesByHome.get(home.configDir);
    const base = {
      configDir: home.configDir,
      service: home.service,
      ownership: home.ownership,
      accountId: profile?.id,
      email: profile?.email ?? profile?.metadata?.email,
    };
    if (store.status === 'absent') {
      if (home.inLedger && !profile && !isRecentPendingLogin(home.configDir, now)) {
        findings.push({
          ...base,
          kind: 'stale-entry',
          detail: 'Ledger entry for a store that no longer exists.',
          action: 'Forget the entry.',
        });
      }
      continue;
    }
    if (!profile) {
      if (isRecentPendingLogin(home.configDir, now)) continue;
      findings.push({
        ...base,
        kind: 'orphan',
        detail: fs.existsSync(home.configDir)
          ? 'Holds a login but belongs to no saved account.'
          : 'Holds a login but its directory no longer exists.',
        action: 'Delete the stored credential.',
      });
      continue;
    }
    if (liveUuid && (profile.providerAccountId ?? profile.id) === liveUuid) {
      findings.push({
        ...base,
        kind: 'live-duplicate',
        detail:
          "The live account's profile home holds a second usable copy of its login; whichever refreshes first invalidates the other.",
        action: 'Remove the copy (installing it into live first if it is newer).',
      });
      continue;
    }
    if (store.status === 'corrupt') {
      findings.push({
        ...base,
        kind: 'corrupt',
        detail: 'The stored credential is not valid JSON (possibly truncated); it cannot be used.',
        action:
          'Delete the unusable store; sign in to this account again if its backup is expired.',
      });
    }
  }
  return { findings, homesChecked: homes.length, keychainScanned };
}

/** Inspect, then (unless `dryRun`) repair every finding. Dry run by default. */
export function repairClaudeCredentialStores(
  options: InspectClaudeCredentialStoresOptions & { dryRun?: boolean } = {},
): ClaudeCredentialRepairResult {
  const dryRun = options.dryRun ?? true;
  const inspection = inspectClaudeCredentialStores(options);
  const result: ClaudeCredentialRepairResult = { ...inspection, dryRun, repaired: [] };
  if (dryRun) return result;

  if (inspection.findings.some((finding) => finding.kind === 'live-duplicate')) {
    result.sync = syncClaudeLiveState();
  }
  for (const finding of inspection.findings) {
    try {
      if (finding.kind === 'live-duplicate') {
        const still = readClaudeCredentialStore(finding.configDir).status;
        result.repaired.push({
          finding,
          ok: still === 'absent',
          error:
            still === 'absent' ? undefined : result.sync?.warnings.join(' ') || 'still present',
        });
        continue;
      }
      if (finding.kind === 'stale-entry') {
        forgetClaudeCredentialHome(finding.configDir);
        result.repaired.push({ finding, ok: true });
        continue;
      }
      const ok = deleteStoredCredentials(finding.configDir);
      if (ok && finding.kind === 'orphan') {
        // An abandoned login directory under our profiles dir goes with it.
        const loginDir = path.dirname(finding.configDir);
        if (
          path.dirname(loginDir) === path.resolve(getClaudeProfilesDir()) &&
          fs.existsSync(loginDir)
        ) {
          fs.rmSync(loginDir, { recursive: true, force: true });
        }
      }
      result.repaired.push({ finding, ok, error: ok ? undefined : 'could not delete' });
    } catch (err) {
      result.repaired.push({ finding, ok: false, error: String(err) });
    }
  }
  return result;
}
