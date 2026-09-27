/** Inspection is read-only. Repairs touch only credential paths Sidekick owns. */
import * as fs from 'fs';
import * as path from 'path';
import { getAccountsDir, listSavedAccountProfiles } from './accountRegistry';
import {
  codexRefreshFingerprint,
  compareCodexAuthFreshness,
  identitiesMatch,
  readAuthIdentityFromRaw,
} from './codexAuth';
import {
  getCodexLoginsDir,
  getCodexBackupPath,
  getCodexCredentialStoreMode,
  getCodexProfileHome,
  getCodexProfilesDir,
  getSystemCodexHome,
} from './codexPaths';
import {
  canonicalCodexPath,
  codexSnapshotFingerprint,
  isCodexLogin,
  isLegacyCodexLogin,
  readCodexBackup,
  readCodexCredentialStore,
  removeCodexProfileCredentials,
  writeCodexBackup,
  type CodexAuthSnapshot,
  type CodexCredentialStoreRead,
} from './codexCredentialStore';
import { isAccountLeaseHeld } from './accountLease';
import { inspectRunningAccountConsumersSync } from './processDetection';
import { syncCodexLiveStateUnlocked, withCodexAuthSwapLock } from './codexProfiles';
import type { ProviderSyncReport } from './accountSyncTypes';

export interface CodexCredentialFinding {
  kind: 'live-duplicate' | 'stale-stash' | 'orphan' | 'corrupt' | 'unreadable' | 'pending-switch';
  configDir: string;
  /** Present for old timestamped stash files. */
  file?: string;
  ownership: 'profile-home' | 'login-home' | 'stash' | 'live' | 'journal' | 'backup';
  accountId?: string;
  email?: string;
  fingerprint?: string;
  detail: string;
  action: string;
}
export interface CodexCredentialInspection {
  findings: CodexCredentialFinding[];
  homesChecked: number;
}
export interface CodexCredentialRepairResult extends CodexCredentialInspection {
  dryRun: boolean;
  repaired: Array<{ finding: CodexCredentialFinding; ok: boolean; error?: string }>;
  sync?: ProviderSyncReport;
}

function within(child: string, root: string): boolean {
  const resolved = canonicalCodexPath(child),
    base = canonicalCodexPath(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}
function ownedDirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => path.join(root, e.name))
      .filter((dir) => within(dir, root));
  } catch {
    return [];
  }
}
function readFinding(
  f: Pick<CodexCredentialFinding, 'file' | 'configDir'>,
): CodexCredentialStoreRead {
  if (!f.file) return readCodexCredentialStore(f.configDir);
  try {
    const raw = fs.readFileSync(f.file, 'utf8');
    const legacy = path.basename(f.file).startsWith('credentials-');
    const snapshot = { authRaw: legacy ? null : raw, legacyRaw: legacy ? raw : null };
    return {
      status: (legacy ? isLegacyCodexLogin(raw) : isCodexLogin(raw)) ? 'ok' : 'corrupt',
      snapshot,
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent', snapshot: { authRaw: null, legacyRaw: null } }
      : { status: 'error' };
  }
}

export function inspectCodexCredentialStores(
  options: { now?: number } = {},
): CodexCredentialInspection {
  const now = options.now ?? Date.now();
  const findings: CodexCredentialFinding[] = [];
  const live = readCodexCredentialStore();
  if (live.status === 'corrupt' || live.status === 'error')
    findings.push({
      kind: live.status === 'error' ? 'unreadable' : 'corrupt',
      configDir: getSystemCodexHome(),
      ownership: 'live',
      detail: 'The live Codex login could not be read; it may be mid-write.',
      action: 'Close Codex and inspect again; live data is never deleted by doctor.',
    });
  const profiles = listSavedAccountProfiles('codex');
  for (const profile of profiles) {
    const backup = readCodexBackup(profile.id);
    if (backup.status === 'error' || backup.status === 'corrupt')
      findings.push({
        kind: backup.status === 'error' ? 'unreadable' : 'corrupt',
        ownership: 'backup',
        accountId: profile.id,
        email: profile.email,
        configDir: path.dirname(getCodexBackupPath(profile.id)),
        file: getCodexBackupPath(profile.id),
        detail: 'The private Codex backup could not be read safely.',
        action: 'Inspect the backup or sign in again; unreadable credentials are preserved.',
      });
  }

  const candidates: Array<Pick<CodexCredentialFinding, 'configDir' | 'file' | 'ownership'>> = [];
  for (const root of [getCodexProfilesDir(), getCodexLoginsDir()]) {
    for (const dir of ownedDirectories(root)) {
      const pending = path.join(dir, 'profile.json');
      if (fs.existsSync(pending)) {
        try {
          const at = Date.parse(
            (JSON.parse(fs.readFileSync(pending, 'utf8')) as { addedAt: string }).addedAt,
          );
          if (!Number.isFinite(at) || now - at < 24 * 60 * 60 * 1000) continue;
        } catch {
          continue;
        }
      }
      const home = path.join(dir, 'codex-home');
      if (
        within(home, root) &&
        canonicalCodexPath(home) !== canonicalCodexPath(getSystemCodexHome())
      ) {
        candidates.push({
          configDir: home,
          ownership: root === getCodexProfilesDir() ? 'profile-home' : 'login-home',
        });
      }
    }
  }
  const stash = path.join(getAccountsDir(), 'codex', 'stash');
  for (const dir of ownedDirectories(stash)) {
    const home = path.join(dir, 'codex-home');
    if (within(home, stash)) candidates.push({ configDir: home, ownership: 'stash' });
  }
  try {
    for (const entry of fs.readdirSync(stash, { withFileTypes: true })) {
      if (entry.isFile() && /^(auth|credentials)-.*\.json$/.test(entry.name))
        candidates.push({
          configDir: stash,
          file: path.join(stash, entry.name),
          ownership: 'stash',
        });
    }
  } catch {
    /* no old stash */
  }
  for (const candidate of candidates) {
    const store = readFinding(candidate);
    if (store.status === 'absent') continue;
    const identity = store.status === 'ok' ? readAuthIdentityFromRaw(store.snapshot.authRaw) : null;
    const profile =
      profiles.find((p) =>
        identitiesMatch(identity, {
          email: p.email ?? p.metadata?.email,
          workspaceId: p.metadata?.workspaceId,
        }),
      ) ??
      profiles.find(
        (p) =>
          canonicalCodexPath(getCodexProfileHome(p.id)) === canonicalCodexPath(candidate.configDir),
      );
    const base = { ...candidate, accountId: profile?.id, email: identity?.email ?? profile?.email };
    if (store.status === 'error' || store.status === 'corrupt') {
      findings.push({
        ...base,
        kind: store.status === 'error' ? 'unreadable' : 'corrupt',
        detail: 'This credential store could not be read safely.',
        action: 'Inspect or sign in again; unreadable credentials are preserved.',
      });
      continue;
    }
    const fingerprint = codexSnapshotFingerprint(store.snapshot);
    const liveDuplicate =
      live.status === 'ok' &&
      (identitiesMatch(identity, readAuthIdentityFromRaw(live.snapshot.authRaw)) ||
        fingerprint === codexSnapshotFingerprint(live.snapshot));
    if (candidate.ownership === 'stash')
      findings.push({
        ...base,
        fingerprint,
        kind: 'stale-stash',
        detail: 'An old stash holds another account credential.',
        action: 'Preserve the freshest known login privately, then remove this credential.',
      });
    else if (liveDuplicate)
      findings.push({
        ...base,
        fingerprint,
        kind: 'live-duplicate',
        detail: 'This home holds a second usable copy of the live Codex login.',
        action: 'Repair a newer login first, then remove the duplicate when Codex is stopped.',
      });
    else if (!profile || candidate.ownership === 'login-home')
      findings.push({
        ...base,
        fingerprint,
        kind: 'orphan',
        detail: 'An abandoned home holds a login outside a saved profile.',
        action:
          'Preserve it under its known account before removing it; unknown identities need manual review.',
      });
  }
  if (fs.existsSync(path.join(getAccountsDir(), 'codex', 'switch-journal.json')))
    findings.push({
      kind: 'pending-switch',
      ownership: 'journal',
      configDir: path.join(getAccountsDir(), 'codex'),
      detail: 'An interrupted account switch needs reconciliation.',
      action: 'Close Codex and finish recovery from the live fingerprint.',
    });
  return { findings, homesChecked: candidates.length + 1 };
}

export function repairCodexCredentialStores(
  options: { now?: number; dryRun?: boolean } = {},
): CodexCredentialRepairResult {
  const inspection = inspectCodexCredentialStores(options);
  const result: CodexCredentialRepairResult = {
    ...inspection,
    dryRun: options.dryRun ?? true,
    repaired: [],
  };
  if (result.dryRun) return result;
  const scan = inspectRunningAccountConsumersSync('codex');
  const mode = getCodexCredentialStoreMode();
  if (!scan.ok || scan.consumers.length || (mode !== 'file' && mode !== 'unknown')) {
    result.repaired = inspection.findings.map((finding) => ({
      finding,
      ok: false,
      error:
        'Repair requires stopped Codex consumers, a successful process scan, and readable file-mode configuration.',
    }));
    return result;
  }
  withCodexAuthSwapLock(() => {
    result.sync = syncCodexLiveStateUnlocked('migration', { scan });
    for (const finding of inspection.findings) {
      let error: string | undefined;
      try {
        if (finding.kind === 'pending-switch') {
          if (fs.existsSync(path.join(finding.configDir, 'switch-journal.json'))) throw new Error();
        } else if (finding.kind === 'live-duplicate' && finding.ownership === 'profile-home') {
          if (readFinding(finding).status !== 'absent') throw new Error();
        } else if (
          finding.kind === 'stale-stash' ||
          finding.kind === 'orphan' ||
          finding.kind === 'live-duplicate'
        ) {
          if (
            !within(finding.file ?? finding.configDir, path.join(getAccountsDir(), 'codex')) ||
            canonicalCodexPath(finding.configDir) === canonicalCodexPath(getSystemCodexHome())
          )
            throw new Error();
          const current = readFinding(finding);
          if (current.status === 'absent') {
            result.repaired.push({ finding, ok: true });
            continue;
          }
          if (
            current.status !== 'ok' ||
            codexSnapshotFingerprint(current.snapshot) !== finding.fingerprint ||
            !finding.accountId ||
            isAccountLeaseHeld('codex', finding.accountId)
          )
            throw new Error();
          const backup = readCodexBackup(finding.accountId);
          if (
            backup.status === 'ok' &&
            compareCodexAuthFreshness(backup.snapshot.authRaw, current.snapshot.authRaw) === 0 &&
            codexSnapshotFingerprint(backup.snapshot) !==
              codexSnapshotFingerprint(current.snapshot) &&
            (!codexRefreshFingerprint(backup.snapshot.authRaw) ||
              codexRefreshFingerprint(backup.snapshot.authRaw) !==
                codexRefreshFingerprint(current.snapshot.authRaw))
          ) {
            throw new Error(); // Two incomparable chains: deletion would guess which is usable.
          }
          const chosen: CodexAuthSnapshot =
            backup.status === 'ok' &&
            compareCodexAuthFreshness(backup.snapshot.authRaw, current.snapshot.authRaw) >= 0
              ? backup.snapshot
              : current.snapshot;
          writeCodexBackup(finding.accountId, chosen);
          const live = readCodexCredentialStore();
          if (
            live.status === 'ok' &&
            identitiesMatch(
              readAuthIdentityFromRaw(live.snapshot.authRaw),
              readAuthIdentityFromRaw(chosen.authRaw),
            ) &&
            compareCodexAuthFreshness(chosen.authRaw, live.snapshot.authRaw) > 0
          ) {
            result.sync = syncCodexLiveStateUnlocked('migration', { scan });
            const repairedLive = readCodexCredentialStore();
            if (
              repairedLive.status !== 'ok' ||
              compareCodexAuthFreshness(repairedLive.snapshot.authRaw, chosen.authRaw) < 0
            )
              throw new Error();
          }
          if (finding.file) fs.rmSync(finding.file);
          else removeCodexProfileCredentials(finding.configDir, current.snapshot);
          if (finding.ownership === 'login-home')
            fs.rmSync(path.dirname(finding.configDir), { recursive: true, force: true });
        } else throw new Error();
      } catch {
        error =
          'Preserved for review: unreadable, ambiguous, changed, leased, or not safely repairable yet.';
      }
      result.repaired.push({ finding, ok: !error, error });
    }
  });
  return result;
}
