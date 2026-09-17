/**
 * Shared shape of a verified account switch plus the undo record. The
 * provider-specific switch cores live in accounts.ts (Claude) and
 * codexProfiles.ts (Codex); accountManager.ts exposes the provider-agnostic
 * `switchAccount*` and `undoLastSwitch` entry points.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getAccountsDir, type AccountProviderId } from './accountRegistry';
import type { AccountHealth } from './accountHealth';
import type { AccountManagerResult } from './accounts';
import type { RunningAccountConsumer } from './processDetection';
import { atomicWriteJsonSync } from './writers/atomic';

export type SwitchVerification = 'store' | 'cli' | 'none' | 'failed';

export interface SwitchAccountResult extends AccountManagerResult {
  provider: AccountProviderId;
  accountId: string;
  previousAccountId: string | null;
  /** True when the live store was re-read after the write and matched the target. */
  verified: boolean;
  verification: SwitchVerification;
  health?: AccountHealth;
  warnings: string[];
  hints: string[];
  runningConsumers: RunningAccountConsumer[];
  /** Present after a successful switch that changed the live login. */
  undoToken?: string;
  /** True when the target was already the live login and nothing was written. */
  alreadyActive?: boolean;
  /** Email of the account now live, when known. */
  email?: string;
}

export interface SwitchAccountOptions {
  /** Also confirm through the provider CLI after the store check (async paths only). */
  verifyWithCli?: boolean;
  /** Switch even when the stored credential is reported expired. */
  force?: boolean;
}

export interface LastSwitchRecord {
  token: string;
  provider: AccountProviderId;
  from: string | null;
  to: string;
  at: string;
}

function providerDirName(provider: AccountProviderId): 'claude' | 'codex' {
  return provider === 'codex' ? 'codex' : 'claude';
}

export function getLastSwitchPath(provider: AccountProviderId): string {
  return path.join(getAccountsDir(), providerDirName(provider), 'last-switch.json');
}

export function readLastSwitch(provider: AccountProviderId): LastSwitchRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getLastSwitchPath(provider), 'utf8'),
    ) as LastSwitchRecord;
    return parsed && typeof parsed.token === 'string' && typeof parsed.to === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function writeLastSwitch(
  provider: AccountProviderId,
  from: string | null,
  to: string,
): LastSwitchRecord {
  const record: LastSwitchRecord = {
    token: randomUUID(),
    provider,
    from,
    to,
    at: new Date().toISOString(),
  };
  atomicWriteJsonSync(getLastSwitchPath(provider), record);
  return record;
}

export function clearLastSwitch(provider: AccountProviderId): void {
  try {
    fs.rmSync(getLastSwitchPath(provider), { force: true });
  } catch {
    /* best effort */
  }
}

export function switchFailure(
  provider: AccountProviderId,
  accountId: string,
  error: string,
  extra: Partial<SwitchAccountResult> = {},
): SwitchAccountResult {
  return {
    success: false,
    error,
    provider,
    accountId,
    previousAccountId: null,
    verified: false,
    verification: 'none',
    warnings: [],
    hints: [],
    runningConsumers: [],
    ...extra,
  };
}

/** Fold per-consumer warnings into a result; keeps `warning` (legacy) in sync. */
export function finishSwitchResult(result: SwitchAccountResult): SwitchAccountResult {
  const warnings = [
    ...result.warnings,
    ...result.runningConsumers.map((consumer) => consumer.reachability),
  ];
  return {
    ...result,
    warnings,
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}
