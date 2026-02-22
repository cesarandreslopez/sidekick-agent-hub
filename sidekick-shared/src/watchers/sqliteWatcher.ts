/**
 * SQLite session watcher for OpenCode.
 * Polls for new messages/parts using timestamp cursor.
 */

import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeDatabase } from '../providers/openCodeDatabase';
import type { DbMessage, DbPart } from '../providers/openCodeDatabase';
import type { FollowEvent, SessionWatcher, SessionWatcherCallbacks } from './types';

const DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 2_000;

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.substring(0, maxLen - 3) + '...' : clean;
}

function normalizeMessage(msg: DbMessage): FollowEvent[] {
  const events: FollowEvent[] = [];
  const ts = new Date(msg.time_created).toISOString();
  try {
    const data = JSON.parse(msg.data) as Record<string, unknown>;
    const role = data.role as string;
    const content = extractContent(data);
    const msgTokens = data.tokens as Record<string, unknown> | undefined;
    const tokens = msgTokens
      ? { input: (msgTokens.input as number) || 0, output: (msgTokens.output as number) || 0 }
      : undefined;
    const cost = (data.cost as number) || undefined;
    const model = (data.modelID as string) || undefined;

    if (role === 'user') {
      events.push({
        providerId: 'opencode', type: 'user', timestamp: ts,
        summary: content || '(user message)', model, raw: data,
      });
    } else if (role === 'assistant') {
      events.push({
        providerId: 'opencode', type: 'assistant', timestamp: ts,
        summary: content || '(thinking...)', tokens, cost, model, raw: data,
      });
    }
  } catch { /* skip malformed */ }
  return events;
}

function normalizePart(part: DbPart): FollowEvent[] {
  const events: FollowEvent[] = [];
  const ts = new Date(part.time_created).toISOString();
  try {
    const data = JSON.parse(part.data) as Record<string, unknown>;
    const type = data.type as string;
    if (type === 'tool' || type === 'tool-invocation') {
      const toolName = (data.tool as string) || 'unknown';
      const state = data.state as string | undefined;
      // tool-invocation with state=result is a tool_result
      const eventType = state === 'result' ? 'tool_result' : 'tool_use';
      const input = data.args ? truncate(JSON.stringify(data.args), 80) : '';
      events.push({
        providerId: 'opencode', type: eventType, timestamp: ts,
        summary: input ? `${toolName} ${input}` : toolName,
        toolName, toolInput: input || undefined, raw: data,
      });
    } else if (type === 'text') {
      const text = (data.text as string) || '';
      if (text) {
        events.push({
          providerId: 'opencode', type: 'assistant', timestamp: ts,
          summary: truncate(text, 200), raw: data,
        });
      }
    }
  } catch { /* skip malformed */ }
  return events;
}

function extractContent(data: Record<string, unknown>): string {
  const content = data.content;
  if (typeof content === 'string') return truncate(content, 200);
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (typeof part.text === 'string') return truncate(part.text as string, 200);
    }
  }
  return '';
}

export class SqliteSessionWatcher implements SessionWatcher {
  private _isActive = false;
  private lastMessageTime = 0;
  private lastPartTime = 0;
  private fsWatcher: fs.FSWatcher | null = null;
  private walWatcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly db: OpenCodeDatabase;
  private readonly dbPath: string;
  private readonly sessionId: string;
  private readonly callbacks: SessionWatcherCallbacks;

  constructor(dbPath: string, sessionId: string, callbacks: SessionWatcherCallbacks) {
    this.dbPath = dbPath;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    this.db = new OpenCodeDatabase(path.dirname(dbPath));
  }

  get isActive(): boolean { return this._isActive; }

  start(replay: boolean): void {
    if (this._isActive) return;
    this._isActive = true;

    if (!this.db.isAvailable() || !this.db.open()) {
      this.callbacks.onError?.(new Error('SQLite database not available'));
      this._isActive = false;
      return;
    }

    if (replay) {
      // Emit all existing events
      this.pollNewData();
    } else {
      // Skip to current timestamps
      this.skipToEnd();
    }

    // Watch db and wal files for changes
    this.watchFile(this.dbPath, (w) => { this.fsWatcher = w; });
    this.watchFile(this.dbPath + '-wal', (w) => { this.walWatcher = w; });

    // Fallback polling
    this.pollTimer = setInterval(() => {
      if (this._isActive) this.pollNewData();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this._isActive) return;
    this._isActive = false;

    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.fsWatcher) { this.fsWatcher.close(); this.fsWatcher = null; }
    if (this.walWatcher) { this.walWatcher.close(); this.walWatcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.db.close();
  }

  private watchFile(filePath: string, setter: (w: fs.FSWatcher) => void): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const watcher = fs.watch(filePath, { persistent: false }, () => {
        this.debouncedPoll();
      });
      watcher.on('error', () => { /* ignore watch errors */ });
      setter(watcher);
    } catch { /* fs.watch not available */ }
  }

  private debouncedPoll(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.pollNewData();
    }, DEBOUNCE_MS);
  }

  private skipToEnd(): void {
    const messages = this.db.getMessagesForSession(this.sessionId);
    const parts = this.db.getPartsForSession(this.sessionId);
    if (messages.length > 0) {
      this.lastMessageTime = Math.max(...messages.map(m => m.time_created));
    }
    if (parts.length > 0) {
      this.lastPartTime = Math.max(...parts.map(p => p.time_created));
    }
  }

  private pollNewData(): void {
    if (!this._isActive) return;
    try {
      const messages = this.db.getMessagesForSession(this.sessionId);
      const parts = this.db.getPartsForSession(this.sessionId);

      // Emit new messages
      const newMessages = messages.filter(m => m.time_created > this.lastMessageTime);
      for (const msg of newMessages) {
        const events = normalizeMessage(msg);
        for (const e of events) this.callbacks.onEvent(e);
        if (msg.time_created > this.lastMessageTime) this.lastMessageTime = msg.time_created;
      }

      // Emit new parts
      const newParts = parts.filter(p => p.time_created > this.lastPartTime);
      for (const part of newParts) {
        const events = normalizePart(part);
        for (const e of events) this.callbacks.onEvent(e);
        if (part.time_created > this.lastPartTime) this.lastPartTime = part.time_created;
      }
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
