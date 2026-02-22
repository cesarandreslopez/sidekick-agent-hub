/**
 * One-shot npm registry check for CLI updates.
 * Fetches latest version from npm, compares with current, caches result for 24h.
 */

declare const __CLI_VERSION__: string;

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from 'sidekick-shared';

// ── Types ──

export interface UpdateInfo {
  current: string;
  latest: string;
}

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

// ── Constants ──

const REGISTRY_URL = 'https://registry.npmjs.org/sidekick-agent-hub/latest';
const CACHE_FILE = 'update-check.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Service ──

export class UpdateCheckService {
  private _callback: ((info: UpdateInfo | null) => void) | null = null;

  /** Register a callback for the update check result. */
  onResult(cb: (info: UpdateInfo | null) => void): void {
    this._callback = cb;
  }

  /** Run the update check (one-shot). */
  async check(): Promise<void> {
    try {
      const current = __CLI_VERSION__;
      const cached = this.readCache();

      let latest: string;
      if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
        latest = cached.latest;
      } else {
        latest = await this.fetchLatest();
        this.writeCache({ latest, checkedAt: Date.now() });
      }

      if (isNewer(latest, current)) {
        this._callback?.({ current, latest });
      } else {
        this._callback?.(null);
      }
    } catch {
      this._callback?.(null);
    }
  }

  private async fetchLatest(): Promise<string> {
    const res = await fetch(REGISTRY_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    const data = await res.json() as { version: string };
    return data.version;
  }

  private readCache(): UpdateCache | null {
    try {
      const cachePath = path.join(getConfigDir(), CACHE_FILE);
      if (!fs.existsSync(cachePath)) return null;
      const content = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(content) as UpdateCache;
      if (parsed.latest && typeof parsed.checkedAt === 'number') {
        return parsed;
      }
    } catch {
      // Corrupt cache — ignore
    }
    return null;
  }

  private writeCache(cache: UpdateCache): void {
    try {
      const configDir = getConfigDir();
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(configDir, CACHE_FILE),
        JSON.stringify(cache),
        'utf8',
      );
    } catch {
      // Non-fatal — cache write failure doesn't affect functionality
    }
  }
}

/**
 * Compare two semver strings. Returns true if `a` is newer than `b`.
 */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}
