import type { SessionEvent } from './sessionEvent';
import type { ProviderId, SessionProviderBase } from '../providers/types';
import { projectSessionTranscript } from '../transcript';
import type { CanonicalTranscriptUsageTotals } from '../transcript';
import {
  classifySessionActivity,
  refreshSessionActivityState,
} from '../parsers/sessionActivityDetector';
import { computeSessionFileStats, providerContextSizeFn } from '../sessionStats';
import { fingerprintString, sessionFingerprintParts } from '../sessionFingerprint';

export type ObservationProvenanceV1 = 'reported' | 'estimated' | 'inferred';

export interface SessionEvidenceRefV1 {
  schemaVersion: 1;
  provider: ProviderId;
  sessionId: string;
  sourcePath?: string;
  eventIndex?: number;
  eventId?: string;
  timestamp?: string;
}

export interface ObservedValueV1<T> {
  value: T;
  provenance: ObservationProvenanceV1;
  confidence: number;
  evidence: SessionEvidenceRefV1[];
}

export interface PendingUserRequestV1 {
  schemaVersion: 1;
  id: string;
  provider: ProviderId;
  sessionId: string;
  kind: ObservedValueV1<'prompt_response' | 'tool_approval' | 'question'>;
  requestedAt: ObservedValueV1<string>;
  prompt: ObservedValueV1<string | null>;
}

export interface ObservedAgentSessionV1 {
  schemaVersion: 1;
  identity: { provider: ProviderId; sessionId: string; sourcePath: string };
  cwd: ObservedValueV1<string>;
  model: ObservedValueV1<string | null>;
  activity: ObservedValueV1<'active' | 'idle' | 'ended' | 'unknown'>;
  usage: {
    inputTokens: ObservedValueV1<number>;
    outputTokens: ObservedValueV1<number>;
    cacheReadTokens: ObservedValueV1<number>;
    cacheWriteTokens: ObservedValueV1<number>;
    normalized?: ObservedValueV1<CanonicalTranscriptUsageTotals>;
    costUsd: ObservedValueV1<number | null>;
  };
  pendingUserRequest: PendingUserRequestV1 | null;
  /** When model/usage content was last read; unchanged on collector cache hits. */
  contentObservedAt?: string;
  observedAt: string;
}

export interface ProviderCapabilitiesV1 {
  schemaVersion: 1;
  provider: ProviderId;
  resume: ObservedValueV1<boolean>;
  forkLineage: ObservedValueV1<boolean>;
  quotaSource: ObservedValueV1<'api' | 'session' | 'mixed' | 'none'>;
  assetExtraction: ObservedValueV1<boolean>;
}

export interface ProviderSessionAdapterV1 {
  readonly schemaVersion: 1;
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilitiesV1;
  discover(cwd: string): Promise<ObservedAgentSessionV1[]>;
  read(sessionPath: string, cwd?: string): Promise<ObservedAgentSessionV1>;
  watch(
    sessionPath: string,
    listener: (session: ObservedAgentSessionV1) => void,
    cwd?: string,
  ): { dispose(): void };
  dispose(): void;
}

function evidence(
  provider: ProviderId,
  sessionId: string,
  sourcePath: string,
  event?: SessionEvent,
  eventIndex?: number,
): SessionEvidenceRefV1[] {
  return [
    {
      schemaVersion: 1,
      provider,
      sessionId,
      sourcePath,
      eventIndex,
      eventId: event?.message?.id,
      timestamp: event?.timestamp,
    },
  ];
}

function observed<T>(
  value: T,
  provenance: ObservationProvenanceV1,
  confidence: number,
  refs: SessionEvidenceRefV1[],
): ObservedValueV1<T> {
  return { value, provenance, confidence, evidence: refs };
}

export function derivePendingUserRequestV1(
  provider: ProviderId,
  sessionId: string,
  sourcePath: string,
  events: SessionEvent[],
): PendingUserRequestV1 | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    // A user/tool-result event after a request means the human has responded.
    if (event.type === 'user') return null;
    const request = waitingToolRequest(event);
    if (request) {
      const refs = evidence(provider, sessionId, sourcePath, event, index);
      return {
        schemaVersion: 1,
        id: `${provider}:${sessionId}:${request.id ?? event.message?.id ?? index}`,
        provider,
        sessionId,
        kind: observed(request.kind, 'inferred', request.kind === 'question' ? 0.95 : 0.9, refs),
        requestedAt: observed(event.timestamp, 'reported', 1, refs),
        prompt: observed(
          request.prompt,
          request.prompt ? 'reported' : 'inferred',
          request.prompt ? 0.95 : 0.4,
          refs,
        ),
      };
    }
    // A later assistant turn proves any older request was already resolved.
    if (event.type === 'assistant' || event.type === 'tool_use') return null;
  }
  return null;
}

function waitingToolRequest(event: SessionEvent): {
  id?: string;
  kind: 'tool_approval' | 'question';
  prompt: string | null;
} | null {
  const calls: Array<{ id?: string; name?: string; input?: unknown }> = [];
  const message = event.message;
  if (event.type === 'tool_use') {
    calls.push({ id: message?.id, name: event.tool?.name, input: event.tool?.input });
  }
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const value = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (value.type !== 'tool_use') continue;
      calls.push({
        id: typeof value.id === 'string' ? value.id : undefined,
        name: typeof value.name === 'string' ? value.name : undefined,
        input: value.input,
      });
    }
  }
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index];
    if (call.name !== 'AskUserQuestion' && call.name !== 'ExitPlanMode') continue;
    return {
      id: call.id,
      kind: call.name === 'AskUserQuestion' ? 'question' : 'tool_approval',
      prompt: waitingToolPrompt(call.input, call.name),
    };
  }
  return null;
}

function waitingToolPrompt(input: unknown, toolName?: string): string | null {
  if (!input || typeof input !== 'object') {
    return toolName === 'ExitPlanMode' ? 'Approve the proposed plan?' : null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.question === 'string') return record.question;
  if (typeof record.prompt === 'string') return record.prompt;
  if (Array.isArray(record.questions)) {
    const questions = record.questions
      .map((question) =>
        question && typeof question === 'object' && 'question' in question
          ? String((question as { question?: unknown }).question ?? '')
          : '',
      )
      .filter(Boolean);
    if (questions.length > 0) return questions.join('\n');
  }
  if (toolName === 'ExitPlanMode') return 'Approve the proposed plan?';
  return null;
}

function providerCapabilities(
  provider: ProviderId,
  observationOnly: boolean,
): ProviderCapabilitiesV1 {
  const refs: SessionEvidenceRefV1[] = [];
  const known = <T>(value: T) => observed(value, 'inferred', 1, refs);
  return {
    schemaVersion: 1,
    provider,
    resume: known(!observationOnly),
    forkLineage: known(provider !== 'opencode'),
    quotaSource: known(
      provider === 'claude-code' ? 'api' : provider === 'codex' ? 'mixed' : 'none',
    ),
    assetExtraction: known(true),
  };
}

/**
 * Detector reason behind each observed session's activity, kept off the
 * versioned V1 shape so cache refreshes can tell a grace-period "active" from
 * a genuinely ongoing one.
 */
const activityReasons = new WeakMap<ObservedAgentSessionV1, string>();

/** The activity detector's reason for a session produced by this adapter, if known. */
export function getObservedActivityReason(session: ObservedAgentSessionV1): string | undefined {
  return activityReasons.get(session);
}

export interface ProviderSessionAdapterV1Options {
  pollIntervalMs?: number;
  observationOnly?: boolean;
}

export function createProviderSessionAdapterV1(
  sessionProvider: SessionProviderBase,
  options: ProviderSessionAdapterV1Options = {},
): ProviderSessionAdapterV1 {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const adapter: ProviderSessionAdapterV1 = {
    schemaVersion: 1,
    provider: sessionProvider.id,
    capabilities: providerCapabilities(sessionProvider.id, options.observationOnly === true),
    async discover(cwd) {
      return Promise.all(
        sessionProvider.findAllSessions(cwd).map((sessionPath) => adapter.read(sessionPath, cwd)),
      );
    },
    async read(sessionPath, cwd = '') {
      // One reader pass feeds stats, transcript, activity, and the pending
      // request; the reader is flushed so a trailing partial line is included.
      const sessionId = sessionProvider.getSessionId(sessionPath);
      const reader = sessionProvider.createReader(sessionPath);
      const events = reader.readAll();
      reader.flush();
      const stats = computeSessionFileStats(events, {
        providerId: sessionProvider.id,
        sessionId,
        filePath: sessionPath,
        label: '',
        computeContextSize: providerContextSizeFn(sessionProvider),
      });
      const transcript = projectSessionTranscript(events, {
        provider: sessionProvider.id,
        sessionId,
        sourcePath: sessionPath,
      });
      const refs = evidence(sessionProvider.id, sessionId, sessionPath);
      const model =
        Object.entries(stats.modelUsage).sort(
          (left, right) => right[1].calls - left[1].calls,
        )[0]?.[0] ?? null;
      const parts = sessionFingerprintParts(sessionProvider, sessionPath);
      const activityResult = classifySessionActivity({ events, mtimeMs: parts?.mtimeMs ?? null });
      const activity =
        activityResult.state === 'ongoing'
          ? 'active'
          : activityResult.state === 'stale'
            ? 'idle'
            : 'ended';
      const allCostsReported =
        transcript.usage.costs.length > 0 &&
        transcript.usage.costs.every((cost) => cost.source === 'provider-reported');
      const observedAt = new Date().toISOString();
      const session: ObservedAgentSessionV1 = {
        schemaVersion: 1,
        identity: {
          provider: sessionProvider.id,
          sessionId,
          sourcePath: sessionPath,
        },
        cwd: observed(cwd, 'inferred', cwd ? 0.95 : 0.4, refs),
        model: observed(model, model ? 'reported' : 'inferred', model ? 1 : 0.2, refs),
        activity: observed(activity, 'inferred', 0.85, refs),
        usage: {
          inputTokens: observed(stats.tokens.input, 'reported', 1, refs),
          outputTokens: observed(stats.tokens.output, 'reported', 1, refs),
          cacheReadTokens: observed(stats.tokens.cacheRead, 'reported', 1, refs),
          cacheWriteTokens: observed(stats.tokens.cacheWrite, 'reported', 1, refs),
          normalized: observed(transcript.usage.totals, 'reported', 1, refs),
          costUsd: observed(
            transcript.usage.totalCostUsd,
            allCostsReported
              ? 'reported'
              : transcript.usage.totalCostUsd === null
                ? 'inferred'
                : 'estimated',
            allCostsReported ? 1 : transcript.usage.totalCostUsd === null ? 0.5 : 0.9,
            refs,
          ),
        },
        pendingUserRequest: derivePendingUserRequestV1(
          sessionProvider.id,
          sessionId,
          sessionPath,
          events,
        ),
        contentObservedAt: observedAt,
        observedAt,
      };
      activityReasons.set(session, activityResult.reason);
      return session;
    },
    watch(sessionPath, listener, cwd) {
      let disposed = false;
      let lastSignature = '';
      let lastFingerprint: string | null = null;
      let lastSession: ObservedAgentSessionV1 | null = null;
      const emitIfChanged = (session: ObservedAgentSessionV1): void => {
        const signature = JSON.stringify({
          activity: session.activity,
          model: session.model,
          usage: session.usage,
          pendingUserRequest: session.pendingUserRequest,
        });
        if (signature !== lastSignature) {
          lastSignature = signature;
          listener(session);
        }
      };
      const update = async () => {
        if (disposed) return;
        try {
          const parts = sessionFingerprintParts(sessionProvider, sessionPath);
          const fingerprint = parts ? fingerprintString(parts) : null;
          if (lastSession && parts && fingerprint === lastFingerprint) {
            // Unchanged content: only the activity can drift with time, so
            // refresh it from the cached classification instead of re-reading.
            const previousReason = activityReasons.get(lastSession);
            const refreshed = refreshSessionActivityState(
              lastSession.activity.value,
              parts.mtimeMs,
              Date.now(),
              previousReason,
            );
            if (refreshed !== lastSession.activity.value) {
              const session: ObservedAgentSessionV1 = {
                ...lastSession,
                activity: { ...lastSession.activity, value: refreshed },
                observedAt: new Date().toISOString(),
              };
              activityReasons.set(
                session,
                refreshed === 'idle'
                  ? 'mtime-stale'
                  : previousReason === 'grace-period'
                    ? 'ending-event'
                    : 'no-activity-signal',
              );
              lastSession = session;
              emitIfChanged(session);
            }
            return;
          }
          const session = await adapter.read(sessionPath, cwd);
          lastFingerprint = fingerprint;
          lastSession = session;
          emitIfChanged(session);
        } catch {
          // Observed sources can disappear between polling iterations.
        }
      };
      void update();
      const timer = setInterval(update, pollIntervalMs);
      timer.unref?.();
      return {
        dispose: () => {
          disposed = true;
          clearInterval(timer);
        },
      };
    },
    dispose: () => sessionProvider.dispose(),
  };
  return adapter;
}
