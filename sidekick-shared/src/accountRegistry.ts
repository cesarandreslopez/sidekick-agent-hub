import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';

export type AccountProviderId = 'claude-code' | 'codex';

export interface AccountIdentityMetadata {
  email?: string;
  workspaceId?: string;
  planType?: string;
  authMode?: 'chatgpt' | 'api-key' | 'unknown';
}

export interface SavedAccountProfile {
  id: string;
  providerId: AccountProviderId;
  addedAt: string;
  label?: string;
  email?: string;
  providerAccountId?: string;
  metadata?: AccountIdentityMetadata;
}

export interface SavedAccountRegistry {
  version: 2;
  activeByProvider: Record<AccountProviderId, string | null>;
  accounts: SavedAccountProfile[];
}

interface LegacyAccountEntry {
  uuid: string;
  email: string;
  label?: string;
  addedAt: string;
}

interface LegacyAccountRegistry {
  version: 1;
  activeAccountUuid: string | null;
  accounts: LegacyAccountEntry[];
}

export function getAccountsDir(): string {
  return path.join(getConfigDir(), 'accounts');
}

function getRegistryPath(): string {
  return path.join(getAccountsDir(), 'accounts.json');
}

function ensureAccountsDir(): void {
  fs.mkdirSync(getAccountsDir(), { recursive: true, mode: 0o700 });
}

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json);
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
}

function createEmptyRegistry(): SavedAccountRegistry {
  return {
    version: 2,
    activeByProvider: {
      'claude-code': null,
      codex: null,
    },
    accounts: [],
  };
}

function normalizeRegistry(registry: Partial<SavedAccountRegistry>): SavedAccountRegistry {
  const normalized = createEmptyRegistry();
  normalized.activeByProvider['claude-code'] = registry.activeByProvider?.['claude-code'] ?? null;
  normalized.activeByProvider.codex = registry.activeByProvider?.codex ?? null;
  normalized.accounts = Array.isArray(registry.accounts)
    ? registry.accounts
        .filter((account): account is SavedAccountProfile =>
          !!account &&
          (account.providerId === 'claude-code' || account.providerId === 'codex') &&
          typeof account.id === 'string' &&
          typeof account.addedAt === 'string',
        )
        .map(account => ({
          ...account,
          label: account.label || undefined,
          email: account.email || undefined,
          providerAccountId: account.providerAccountId || undefined,
          metadata: account.metadata ? {
            email: account.metadata.email || undefined,
            workspaceId: account.metadata.workspaceId || undefined,
            planType: account.metadata.planType || undefined,
            authMode: account.metadata.authMode || undefined,
          } : undefined,
        }))
    : [];
  return normalized;
}

function migrateLegacyRegistry(legacy: LegacyAccountRegistry): SavedAccountRegistry {
  return {
    version: 2,
    activeByProvider: {
      'claude-code': legacy.activeAccountUuid,
      codex: null,
    },
    accounts: legacy.accounts.map(account => ({
      id: account.uuid,
      providerId: 'claude-code' as const,
      providerAccountId: account.uuid,
      email: account.email,
      label: account.label,
      addedAt: account.addedAt,
      metadata: {
        email: account.email,
      },
    })),
  };
}

export function readSavedAccountRegistry(): SavedAccountRegistry | null {
  try {
    const content = fs.readFileSync(getRegistryPath(), 'utf8');
    const parsed = JSON.parse(content) as Partial<SavedAccountRegistry> | LegacyAccountRegistry;

    if (parsed?.version === 2) {
      return normalizeRegistry(parsed as Partial<SavedAccountRegistry>);
    }

    if (parsed?.version === 1 && Array.isArray(parsed.accounts)) {
      return migrateLegacyRegistry(parsed as LegacyAccountRegistry);
    }

    return null;
  } catch {
    return null;
  }
}

export function writeSavedAccountRegistry(registry: SavedAccountRegistry): void {
  ensureAccountsDir();
  atomicWriteJson(getRegistryPath(), normalizeRegistry(registry));
}

export function listSavedAccountProfiles(providerId?: AccountProviderId): SavedAccountProfile[] {
  const registry = readSavedAccountRegistry();
  if (!registry) return [];
  return providerId
    ? registry.accounts.filter(account => account.providerId === providerId)
    : registry.accounts;
}

export function getActiveSavedAccount(providerId: AccountProviderId): SavedAccountProfile | null {
  const registry = readSavedAccountRegistry();
  if (!registry) return null;
  const activeId = registry.activeByProvider[providerId];
  if (!activeId) return null;
  return registry.accounts.find(account => account.providerId === providerId && account.id === activeId) ?? null;
}

export function upsertSavedAccountProfile(profile: SavedAccountProfile): SavedAccountRegistry {
  const registry = readSavedAccountRegistry() ?? createEmptyRegistry();
  const index = registry.accounts.findIndex(account => account.providerId === profile.providerId && account.id === profile.id);
  if (index >= 0) {
    registry.accounts[index] = profile;
  } else {
    registry.accounts.push(profile);
  }
  writeSavedAccountRegistry(registry);
  return registry;
}

export function setActiveSavedAccount(providerId: AccountProviderId, accountId: string | null): SavedAccountRegistry {
  const registry = readSavedAccountRegistry() ?? createEmptyRegistry();
  registry.activeByProvider[providerId] = accountId;
  writeSavedAccountRegistry(registry);
  return registry;
}

export function replaceSavedAccountProfiles(
  providerId: AccountProviderId,
  accounts: SavedAccountProfile[],
  activeId: string | null,
): SavedAccountRegistry {
  const registry = readSavedAccountRegistry() ?? createEmptyRegistry();
  registry.accounts = registry.accounts.filter(account => account.providerId !== providerId).concat(accounts);
  registry.activeByProvider[providerId] = activeId;
  writeSavedAccountRegistry(registry);
  return registry;
}

export function removeSavedAccountProfile(providerId: AccountProviderId, accountId: string): SavedAccountProfile | null {
  const registry = readSavedAccountRegistry();
  if (!registry) return null;

  const index = registry.accounts.findIndex(account => account.providerId === providerId && account.id === accountId);
  if (index === -1) return null;

  const [removed] = registry.accounts.splice(index, 1);
  if (registry.activeByProvider[providerId] === accountId) {
    registry.activeByProvider[providerId] =
      registry.accounts.find(account => account.providerId === providerId)?.id ?? null;
  }
  writeSavedAccountRegistry(registry);
  return removed;
}
