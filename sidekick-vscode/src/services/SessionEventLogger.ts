/**
 * @fileoverview Session event logger for persisting normalized events to disk.
 *
 * Appends every ClaudeSessionEvent to a JSONL file as SessionMonitor processes it,
 * creating an audit trail for debugging and replay. Each session gets its own file
 * under `~/.config/sidekick/event-logs/{provider}/{sessionId}.jsonl`.
 *
 * Off by default; toggled via the dashboard's "Event Log" checkbox.
 *
 * @module services/SessionEventLogger
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ClaudeSessionEvent } from '../types/claudeSession';
import type {
  SessionEventLogEntry,
  SessionEventLogManifest,
  SessionLogMetadata,
} from '../types/sessionEventLog';
import { EVENT_LOG_SCHEMA_VERSION } from '../types/sessionEventLog';
import { log, logError } from './Logger';

/**
 * Persists normalized session events to JSONL files for debugging.
 *
 * Follows the same lifecycle pattern as {@link HistoricalDataService}:
 * initialize → use → dispose, with debounced manifest saves and
 * atomic writes via temp-file-then-rename.
 */
export class SessionEventLogger implements vscode.Disposable {
  /** Root directory for all event logs */
  private eventLogsDir: string;

  /** In-memory manifest */
  private manifest: SessionEventLogManifest;

  /** Path to the manifest file */
  private manifestPath: string;

  /** Whether the manifest has unsaved changes */
  private manifestDirty = false;

  /** Debounce timer for manifest saves */
  private saveTimer: NodeJS.Timeout | null = null;

  /** Manifest save debounce (5 seconds, matching HistoricalDataService) */
  private readonly SAVE_DEBOUNCE_MS = 5000;

  // ── Active session state ──────────────────────────────────────────

  /** Write stream for the current session log file */
  private stream: fs.WriteStream | null = null;

  /** Provider ID of the active session */
  private activeProviderId: string | null = null;

  /** Session ID of the active session */
  private activeSessionId: string | null = null;

  /** Monotonic sequence counter for the active session */
  private seq = 0;

  /** Manifest key for the active session ("{providerId}/{sessionId}") */
  private activeKey: string | null = null;

  constructor() {
    this.eventLogsDir = this.getEventLogsDir();
    this.manifestPath = path.join(this.eventLogsDir, 'sessions.json');
    this.manifest = {
      schemaVersion: EVENT_LOG_SCHEMA_VERSION,
      sessions: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Creates the event-logs directory tree, loads the manifest, and
   * runs size/age-based cleanup.
   */
  async initialize(): Promise<void> {
    try {
      await fs.promises.mkdir(this.eventLogsDir, { recursive: true });

      if (fs.existsSync(this.manifestPath)) {
        const raw = await fs.promises.readFile(this.manifestPath, 'utf-8');
        this.manifest = JSON.parse(raw) as SessionEventLogManifest;
        log(`SessionEventLogger: loaded manifest with ${Object.keys(this.manifest.sessions).length} sessions`);
      } else {
        log('SessionEventLogger: initialized new manifest');
      }

      await this.cleanup();
    } catch (error) {
      logError('SessionEventLogger: failed to initialize', error);
    }
  }

  /**
   * Opens a write stream for a new session log file.
   *
   * If a previous session is still active it is ended first.
   */
  startSession(providerId: string, sessionId: string): void {
    // Close any lingering stream from a previous session
    if (this.stream) {
      this.endSession();
    }

    try {
      const providerDir = path.join(this.eventLogsDir, providerId);
      fs.mkdirSync(providerDir, { recursive: true });

      const filePath = path.join(providerDir, `${sessionId}.jsonl`);
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.stream.on('error', (err) => {
        logError('SessionEventLogger: write stream error', err);
        this.closeStream();
      });

      this.activeProviderId = providerId;
      this.activeSessionId = sessionId;
      this.activeKey = `${providerId}/${sessionId}`;
      this.seq = 0;

      // If this session was logged before, continue its sequence
      const existing = this.manifest.sessions[this.activeKey];
      if (existing) {
        this.seq = existing.eventCount;
      }

      log(`SessionEventLogger: started logging for ${this.activeKey}`);
    } catch (error) {
      logError('SessionEventLogger: failed to start session', error);
      this.closeStream();
    }
  }

  /**
   * Appends a normalized event to the active session log.
   *
   * Non-blocking — write failures are logged and the stream is closed.
   * Subsequent calls become no-ops until a new session is started.
   */
  logEvent(event: ClaudeSessionEvent): void {
    if (!this.stream || !this.activeProviderId || !this.activeSessionId || !this.activeKey) {
      return;
    }

    try {
      this.seq++;
      const entry: SessionEventLogEntry = {
        seq: this.seq,
        processedAt: new Date().toISOString(),
        providerId: this.activeProviderId as SessionEventLogEntry['providerId'],
        sessionId: this.activeSessionId,
        event,
      };

      this.stream.write(JSON.stringify(entry) + '\n');

      // Update in-memory manifest metadata
      const now = entry.processedAt;
      let meta = this.manifest.sessions[this.activeKey];
      if (!meta) {
        meta = {
          providerId: this.activeProviderId,
          sessionId: this.activeSessionId,
          filePath: `${this.activeProviderId}/${this.activeSessionId}.jsonl`,
          firstEventAt: now,
          lastEventAt: now,
          eventCount: 0,
          fileSizeBytes: 0,
        };
        this.manifest.sessions[this.activeKey] = meta;
      }

      meta.lastEventAt = now;
      meta.eventCount = this.seq;
      this.manifestDirty = true;
      this.scheduleManifestSave();
    } catch (error) {
      logError('SessionEventLogger: failed to log event', error);
      this.closeStream();
    }
  }

  /**
   * Flushes and closes the active write stream, saves the manifest.
   */
  endSession(): void {
    if (!this.stream) {
      return;
    }

    log(`SessionEventLogger: ending session ${this.activeKey}`);
    this.closeStream();
    this.saveManifestNow();
  }

  /**
   * Returns whether a write stream is currently open.
   */
  isSessionActive(): boolean {
    return this.stream !== null;
  }

  /**
   * Disposes of the logger — closes the stream and saves the manifest synchronously.
   */
  dispose(): void {
    this.closeStream();

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.manifestDirty) {
      try {
        this.updateManifestFileSizes();
        this.manifest.lastUpdated = new Date().toISOString();
        const content = JSON.stringify(this.manifest, null, 2);
        fs.writeFileSync(this.manifestPath, content, 'utf-8');
        log('SessionEventLogger: manifest saved on dispose');
      } catch (error) {
        logError('SessionEventLogger: failed to save manifest on dispose', error);
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Resolves the event-logs directory path based on platform.
   */
  private getEventLogsDir(): string {
    const configDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'sidekick')
      : path.join(os.homedir(), '.config', 'sidekick');
    return path.join(configDir, 'event-logs');
  }

  /** Closes the write stream and resets active session state. */
  private closeStream(): void {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // Best effort
      }
      this.stream = null;
    }
    this.activeProviderId = null;
    this.activeSessionId = null;
    this.activeKey = null;
    this.seq = 0;
  }

  /** Schedules a debounced manifest save. */
  private scheduleManifestSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveManifestNow();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /** Saves the manifest immediately using atomic temp+rename. */
  private saveManifestNow(): void {
    if (!this.manifestDirty) {
      return;
    }

    try {
      this.updateManifestFileSizes();
      this.manifest.lastUpdated = new Date().toISOString();
      const content = JSON.stringify(this.manifest, null, 2);
      const tmpPath = this.manifestPath + '.tmp';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, this.manifestPath);
      this.manifestDirty = false;
    } catch (error) {
      logError('SessionEventLogger: failed to save manifest', error);
    }
  }

  /** Updates fileSizeBytes in the manifest for all tracked sessions. */
  private updateManifestFileSizes(): void {
    for (const meta of Object.values(this.manifest.sessions)) {
      try {
        const fullPath = path.join(this.eventLogsDir, meta.filePath);
        if (fs.existsSync(fullPath)) {
          meta.fileSizeBytes = fs.statSync(fullPath).size;
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
  }

  /**
   * Removes log files older than maxAgeDays and trims oldest files
   * when total size exceeds maxSizeMB.
   */
  private async cleanup(): Promise<void> {
    const config = vscode.workspace.getConfiguration('sidekick');
    const maxAgeDays = config.get<number>('eventLogMaxAgeDays', 30);
    const maxSizeMB = config.get<number>('eventLogMaxSizeMB', 500);
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    let totalSize = 0;
    const entries: Array<{ key: string; meta: SessionLogMetadata; mtime: number }> = [];
    const keysToRemove: string[] = [];

    for (const [key, meta] of Object.entries(this.manifest.sessions)) {
      const fullPath = path.join(this.eventLogsDir, meta.filePath);
      try {
        const stat = fs.statSync(fullPath);
        meta.fileSizeBytes = stat.size;

        // Age-based removal
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          keysToRemove.push(key);
          log(`SessionEventLogger: cleaned up old log ${meta.filePath}`);
          continue;
        }

        totalSize += stat.size;
        entries.push({ key, meta, mtime: stat.mtimeMs });
      } catch {
        // File missing — remove from manifest
        keysToRemove.push(key);
      }
    }

    // Size-based removal (oldest first)
    if (totalSize > maxSizeBytes) {
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const entry of entries) {
        if (totalSize <= maxSizeBytes) {
          break;
        }
        try {
          const fullPath = path.join(this.eventLogsDir, entry.meta.filePath);
          fs.unlinkSync(fullPath);
          totalSize -= entry.meta.fileSizeBytes;
          keysToRemove.push(entry.key);
          log(`SessionEventLogger: cleaned up oversized log ${entry.meta.filePath}`);
        } catch {
          // Best effort
        }
      }
    }

    if (keysToRemove.length > 0) {
      for (const key of keysToRemove) {
        delete this.manifest.sessions[key];
      }
      this.manifestDirty = true;
      this.saveManifestNow();
      log(`SessionEventLogger: cleanup removed ${keysToRemove.length} log(s)`);
    }
  }
}
