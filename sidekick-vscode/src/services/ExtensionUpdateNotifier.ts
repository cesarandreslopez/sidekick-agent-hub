/**
 * @fileoverview Tells the user when a newer Sidekick Agent Hub extension is published.
 *
 * VS Code proper installs from the Visual Studio Marketplace; Cursor, VSCodium,
 * Windsurf and other forks install from Open VSX. The two are published at
 * different times (Open VSX by the release workflow, the Marketplace by hand
 * afterwards), so the check asks the registry this editor will actually update
 * from. That way the Update button never points at a version the editor cannot
 * install yet.
 *
 * Results are kept in `globalState`, which every window shares, so several open
 * windows make one registry request per {@link UPDATE_CHECK_INTERVAL_MS} and
 * repeat the notification for a version at most that often.
 *
 * @module ExtensionUpdateNotifier
 */

import * as vscode from 'vscode';
import { EXTENSION_ID, isNewer } from './SidekickCliService';
import { log, logError } from './Logger';

export type ExtensionRegistry = 'marketplace' | 'openvsx';

/** Persisted under {@link UPDATE_STATE_KEY} in `globalState`. */
export interface ExtensionUpdateState {
  latest?: string;
  /** Registry `latest` came from; an answer from the other registry is not reused. */
  registry?: ExtensionRegistry;
  /** Last registry attempt, successful or not (epoch ms). */
  checkedAt?: number;
  notifiedAt?: number;
  notifiedVersion?: string;
  skippedVersion?: string;
}

/** Minimal `vscode.Memento` surface, so tests can pass a plain map. */
export interface UpdateStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ExtensionUpdateNotifierOptions {
  currentVersion: string;
  globalState: UpdateStateStore;
  /** `vscode.env.uriScheme`: `vscode` / `vscode-insiders` use the Marketplace. */
  uriScheme: string;
  /** Reads `sidekick.updateCheck.enabled`; only automatic checks honor it. */
  isEnabled?: () => boolean;
  now?: () => number;
  fetchLatest?: (registry: ExtensionRegistry, signal: AbortSignal) => Promise<string>;
}

export const UPDATE_STATE_KEY = 'sidekick.extensionUpdateCheck';
/** Registry refresh interval, and the minimum gap between repeat notifications (twice a day). */
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Delay before the first automatic check, to stay off the activation path. */
export const FIRST_CHECK_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 5000;

const [PUBLISHER, EXTENSION_NAME] = EXTENSION_ID.split('.');
const OPEN_VSX_LATEST_URL = `https://open-vsx.org/api/${PUBLISHER}/${EXTENSION_NAME}/latest`;
const MARKETPLACE_QUERY_URL =
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const RELEASE_URL_PREFIX = 'https://github.com/cesarandreslopez/sidekick-agent-hub/releases/tag/v';
/**
 * Marketplace query flags: IncludeVersions | IncludeVersionProperties |
 * IncludeLatestVersionOnly. Without the last flag the response lists every
 * version ever published (~170 KB instead of ~2.5 KB).
 */
const MARKETPLACE_FLAGS = 0x1 | 0x10 | 0x200;
/** Marketplace query filter type for an exact `publisher.name`. */
const MARKETPLACE_FILTER_EXTENSION_NAME = 7;
const PRE_RELEASE_PROPERTY = 'Microsoft.VisualStudio.Code.PreRelease';

function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

/** The registry an editor with this URI scheme installs extensions from. */
export function registryForUriScheme(uriScheme: string): ExtensionRegistry {
  return uriScheme === 'vscode' || uriScheme === 'vscode-insiders' ? 'marketplace' : 'openvsx';
}

interface MarketplaceVersion {
  version?: unknown;
  properties?: Array<{ key?: unknown; value?: unknown }>;
}

/** Newest non-pre-release version in a Marketplace `extensionquery` response. */
export function parseMarketplaceResponse(data: unknown): string | null {
  const versions = (
    data as { results?: Array<{ extensions?: Array<{ versions?: MarketplaceVersion[] }> }> }
  )?.results?.[0]?.extensions?.[0]?.versions;
  if (!Array.isArray(versions)) return null;
  for (const entry of versions) {
    const preRelease = entry.properties?.some(
      (property) => property.key === PRE_RELEASE_PROPERTY && property.value === 'true',
    );
    if (!preRelease && isReleaseVersion(entry.version)) return entry.version;
  }
  return null;
}

/** Version in an Open VSX `/latest` response, unless it is a pre-release. */
export function parseOpenVsxResponse(data: unknown): string | null {
  const body = data as { version?: unknown; preRelease?: unknown } | null;
  if (!body || body.preRelease === true) return null;
  return isReleaseVersion(body.version) ? body.version : null;
}

export async function fetchLatestExtensionVersion(
  registry: ExtensionRegistry,
  signal: AbortSignal,
): Promise<string> {
  const response =
    registry === 'marketplace'
      ? await fetch(MARKETPLACE_QUERY_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json;api-version=3.0-preview.1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filters: [
              {
                criteria: [{ filterType: MARKETPLACE_FILTER_EXTENSION_NAME, value: EXTENSION_ID }],
              },
            ],
            flags: MARKETPLACE_FLAGS,
          }),
          signal,
        })
      : await fetch(OPEN_VSX_LATEST_URL, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`${registry} returned HTTP ${response.status}`);
  const data: unknown = await response.json();
  const version =
    registry === 'marketplace' ? parseMarketplaceResponse(data) : parseOpenVsxResponse(data);
  if (!version) throw new Error(`${registry} response has no release version`);
  return version;
}

export class ExtensionUpdateNotifier implements vscode.Disposable {
  private readonly currentVersion: string;
  private readonly globalState: UpdateStateStore;
  private readonly registry: ExtensionRegistry;
  private readonly isEnabled: () => boolean;
  private readonly now: () => number;
  private readonly fetchLatest: (
    registry: ExtensionRegistry,
    signal: AbortSignal,
  ) => Promise<string>;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(options: ExtensionUpdateNotifierOptions) {
    this.currentVersion = options.currentVersion;
    this.globalState = options.globalState;
    this.registry = registryForUriScheme(options.uriScheme);
    this.isEnabled = options.isEnabled ?? (() => true);
    this.now = options.now ?? Date.now;
    this.fetchLatest = options.fetchLatest ?? fetchLatestExtensionVersion;
  }

  /** Schedule the automatic checks: shortly after activation, then twice a day. */
  start(): void {
    this.firstTimer = setTimeout(() => void this.check({ manual: false }), FIRST_CHECK_DELAY_MS);
    this.interval = setInterval(() => void this.check({ manual: false }), UPDATE_CHECK_INTERVAL_MS);
  }

  /**
   * Check for a newer version. An automatic check honors the setting, the
   * cache, the skipped version and the twice-a-day repeat limit; a manual check
   * (the "Check for Updates" command) always asks the registry, always
   * answers, and ignores a skipped version.
   */
  check(options: { manual: boolean }): Promise<void> {
    if (!options.manual && !this.isEnabled()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck(options.manual).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  dispose(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.interval) clearInterval(this.interval);
    this.firstTimer = undefined;
    this.interval = undefined;
  }

  private readState(): ExtensionUpdateState {
    return this.globalState.get<ExtensionUpdateState>(UPDATE_STATE_KEY) ?? {};
  }

  private async writeState(state: ExtensionUpdateState): Promise<void> {
    try {
      await this.globalState.update(UPDATE_STATE_KEY, state);
    } catch (error) {
      logError('Could not save the extension update check state', error);
    }
  }

  private async runCheck(manual: boolean): Promise<void> {
    let state = this.readState();
    const at = this.now();
    // An answer cached by an editor that uses the other registry is not reused.
    const sameRegistry = state.registry === this.registry;
    let latest = sameRegistry ? state.latest : undefined;
    const age = sameRegistry && state.checkedAt !== undefined ? at - state.checkedAt : Infinity;
    const fresh = age >= 0 && age < UPDATE_CHECK_INTERVAL_MS;

    if (manual || !fresh) {
      try {
        latest = await this.fetchLatest(this.registry, AbortSignal.timeout(FETCH_TIMEOUT_MS));
        state = { ...state, latest, registry: this.registry, checkedAt: at };
        log(
          `Extension update check (${this.registry}): latest ${latest}, installed ${this.currentVersion}`,
        );
      } catch (error) {
        // Stamped anyway, so a machine that cannot reach the registry retries
        // twice a day rather than in every window it opens.
        state = { ...state, latest, registry: this.registry, checkedAt: at };
        await this.writeState(state);
        logError(`Extension update check (${this.registry}) failed`, error);
        if (manual) {
          void vscode.window.showWarningMessage(
            `Could not check for Sidekick Agent Hub updates: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      await this.writeState(state);
    }

    if (!latest || !isNewer(latest, this.currentVersion)) {
      if (manual) {
        void vscode.window.showInformationMessage(
          `Sidekick Agent Hub is up to date (${this.currentVersion}).`,
        );
      }
      return;
    }

    if (!manual) {
      if (state.skippedVersion === latest) return;
      const sinceNotified = state.notifiedAt === undefined ? Infinity : at - state.notifiedAt;
      const shownRecently =
        state.notifiedVersion === latest &&
        sinceNotified >= 0 &&
        sinceNotified < UPDATE_CHECK_INTERVAL_MS;
      if (shownRecently) return;
    }

    await this.writeState({ ...state, notifiedAt: at, notifiedVersion: latest });
    // Not awaited: the notification stays open until the user acts on it.
    void this.showUpdateNotification(latest);
  }

  private async showUpdateNotification(latest: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Sidekick Agent Hub ${latest} is available (you have ${this.currentVersion}).`,
      'Update',
      'Release Notes',
      'Skip This Version',
    );
    if (choice === 'Update') {
      await this.installUpdate(latest);
    } else if (choice === 'Release Notes') {
      await vscode.env.openExternal(vscode.Uri.parse(`${RELEASE_URL_PREFIX}${latest}`));
    } else if (choice === 'Skip This Version') {
      await this.writeState({ ...this.readState(), skippedVersion: latest });
    }
  }

  private async installUpdate(latest: string): Promise<void> {
    try {
      // Installing an already-installed extension by ID installs the gallery's
      // newest version over it.
      await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSION_ID);
      const reload = await vscode.window.showInformationMessage(
        `Sidekick Agent Hub ${latest} is installed. Reload the window to start using it.`,
        'Reload Window',
      );
      if (reload === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (error) {
      logError('Installing the extension update failed; opening the extension page', error);
      await vscode.commands.executeCommand('extension.open', EXTENSION_ID);
    }
  }
}
