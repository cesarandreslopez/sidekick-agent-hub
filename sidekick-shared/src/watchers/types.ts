/**
 * Types for live session following / streaming.
 */

import type { ProviderId } from '../providers/types';

export type FollowEventType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'summary' | 'system';

export interface FollowEvent {
  providerId: ProviderId;
  type: FollowEventType;
  timestamp: string;
  /** Human-readable summary of the event. */
  summary: string;
  model?: string;
  tokens?: { input: number; output: number };
  cacheTokens?: { read: number; write: number };
  cost?: number;
  toolName?: string;
  toolInput?: string;
  /** Subscription rate limits (Codex token_count events). */
  rateLimits?: {
    primary?: { usedPercent: number; windowMinutes: number; resetsAt: number };
    secondary?: { usedPercent: number; windowMinutes: number; resetsAt: number };
  };
  /** Original raw event for JSON output. */
  raw?: unknown;
}

export interface SessionWatcherCallbacks {
  onEvent: (event: FollowEvent) => void;
  onError?: (error: Error) => void;
}

export interface SessionWatcher {
  /** Start watching. If replay=true, emit existing events before streaming. */
  start(replay: boolean): void;
  stop(): void;
  readonly isActive: boolean;
}

export interface CreateWatcherOptions {
  providerId: ProviderId;
  sessionPath: string;
  callbacks: SessionWatcherCallbacks;
}
