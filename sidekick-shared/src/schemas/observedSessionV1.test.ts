import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  observedAgentSessionV1Schema,
  pendingUserRequestV1Schema,
  providerCapabilitiesV1Schema,
  providerSessionAdapterV1Schema,
  sessionEvidenceRefV1Schema,
} from './observedSessionV1';
import {
  createProviderSessionAdapterV1,
  derivePendingUserRequestV1,
} from '../types/observedSessionV1';
import type { SessionEvent } from '../types/sessionEvent';
import { ClaudeCodeProvider } from '../providers/claudeCode';

const ref = {
  schemaVersion: 1 as const,
  provider: 'codex' as const,
  sessionId: 'session-1',
  sourcePath: '/tmp/session.jsonl',
  eventIndex: 3,
};
const observed = <T>(value: T) => ({
  value,
  provenance: 'reported' as const,
  confidence: 1,
  evidence: [ref],
});
const runtimeEvent = (event: Record<string, unknown>) => event as unknown as SessionEvent;

describe('observed-session v1 public contracts', () => {
  it('derives only unresolved agent-to-human requests', () => {
    const request = {
      type: 'assistant' as const,
      timestamp: '2026-07-18T00:00:00Z',
      message: {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use',
            id: 'ask-1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which database should I use?' }] },
          },
        ],
      },
    };
    expect(
      derivePendingUserRequestV1('claude-code', 'session-1', '/tmp/session.jsonl', [request]),
    ).toMatchObject({
      id: 'claude-code:session-1:ask-1',
      kind: { value: 'question' },
      prompt: { value: 'Which database should I use?' },
    });
    expect(
      derivePendingUserRequestV1('claude-code', 'session-1', '/tmp/session.jsonl', [
        request,
        {
          type: 'user',
          timestamp: '2026-07-18T00:00:01Z',
          message: { role: 'user', content: 'PostgreSQL' },
        },
      ]),
    ).toBeNull();
  });

  it('ignores message-less summary events', () => {
    const summary = runtimeEvent({
      type: 'summary',
      timestamp: '2026-07-18T00:00:01Z',
      summary: 'Earlier messages were compacted',
    });

    expect(
      derivePendingUserRequestV1('claude-code', 'session-1', '/tmp/session.jsonl', [summary]),
    ).toBeNull();
  });

  it('finds an unresolved request before a message-less bookkeeping row', () => {
    const request = runtimeEvent({
      type: 'assistant',
      timestamp: '2026-07-18T00:00:00Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'ask-1',
            name: 'AskUserQuestion',
            input: { question: 'Which database should I use?' },
          },
        ],
      },
    });
    const summary = runtimeEvent({
      type: 'summary',
      timestamp: '2026-07-18T00:00:01Z',
      summary: 'Earlier messages were compacted',
    });

    expect(
      derivePendingUserRequestV1('claude-code', 'session-1', '/tmp/session.jsonl', [
        request,
        summary,
      ]),
    ).toMatchObject({
      id: 'claude-code:session-1:ask-1',
      kind: { value: 'question' },
      prompt: { value: 'Which database should I use?' },
    });
  });

  it('uses the event index for a message-less top-level tool request ID', () => {
    const request = runtimeEvent({
      type: 'tool_use',
      timestamp: '2026-07-18T00:00:00Z',
      tool: {
        name: 'AskUserQuestion',
        input: { question: 'Continue?' },
      },
    });

    expect(
      derivePendingUserRequestV1('claude-code', 'session-1', '/tmp/session.jsonl', [request]),
    ).toMatchObject({
      id: 'claude-code:session-1:0',
      kind: {
        value: 'question',
        evidence: [{ eventIndex: 0, eventId: undefined }],
      },
      prompt: { value: 'Continue?' },
    });
  });

  it('adapts a Claude Code transcript containing a message-less row', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sidekick-observed-session-'));
    const sessionPath = path.join(directory, 'session-1.jsonl');
    const adapter = createProviderSessionAdapterV1(new ClaudeCodeProvider());
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: 'summary',
        timestamp: '2026-07-18T00:00:00Z',
        summary: 'Earlier messages were compacted',
      })}\n`,
    );

    try {
      const session = await adapter.read(sessionPath, '/tmp/project');
      expect(observedAgentSessionV1Schema.parse(session)).toMatchObject({
        identity: {
          provider: 'claude-code',
          sessionId: 'session-1',
          sourcePath: sessionPath,
        },
        pendingUserRequest: null,
      });
    } finally {
      adapter.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('projects observation-only capabilities without resumability', () => {
    const adapter = createProviderSessionAdapterV1(new ClaudeCodeProvider(), {
      observationOnly: true,
    });
    try {
      expect(adapter.capabilities.resume).toMatchObject({
        value: false,
        provenance: 'inferred',
      });
    } finally {
      adapter.dispose();
    }
  });

  it('validates the checked-in JSON fixtures for every serializable V1 shape', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'fixtures', 'observed-session-v1.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(sessionEvidenceRefV1Schema.safeParse(fixture.evidence).success).toBe(true);
    expect(pendingUserRequestV1Schema.safeParse(fixture.pendingUserRequest).success).toBe(true);
    expect(providerCapabilitiesV1Schema.safeParse(fixture.capabilities).success).toBe(true);
    expect(observedAgentSessionV1Schema.safeParse(fixture.session).success).toBe(true);
  });

  it('validates stable evidence and pending-human records', () => {
    expect(sessionEvidenceRefV1Schema.parse(ref)).toEqual(ref);
    expect(
      pendingUserRequestV1Schema.safeParse({
        schemaVersion: 1,
        id: 'request-1',
        provider: 'codex',
        sessionId: 'session-1',
        kind: observed('prompt_response'),
        requestedAt: observed('2026-07-18T00:00:00Z'),
        prompt: observed('Continue?'),
      }).success,
    ).toBe(true);
  });

  it('validates observed sessions, capabilities, and adapter shape', () => {
    const capabilities = {
      schemaVersion: 1 as const,
      provider: 'codex' as const,
      resume: observed(true),
      forkLineage: observed(true),
      quotaSource: observed('mixed'),
      assetExtraction: observed(true),
    };
    expect(providerCapabilitiesV1Schema.safeParse(capabilities).success).toBe(true);
    const session = {
      schemaVersion: 1 as const,
      identity: {
        provider: 'codex' as const,
        sessionId: 'session-1',
        sourcePath: ref.sourcePath,
      },
      cwd: observed('/tmp/project'),
      model: observed('gpt-5'),
      activity: observed('active'),
      usage: {
        inputTokens: observed(100),
        outputTokens: observed(20),
        cacheReadTokens: observed(0),
        cacheWriteTokens: observed(0),
        costUsd: observed(0.01),
      },
      pendingUserRequest: null,
      observedAt: '2026-07-18T00:00:00Z',
    };
    expect(observedAgentSessionV1Schema.safeParse(session).success).toBe(true);
    expect(
      providerSessionAdapterV1Schema.safeParse({
        schemaVersion: 1,
        provider: 'codex',
        capabilities,
        discover() {},
        read() {},
        watch() {},
        dispose() {},
      }).success,
    ).toBe(true);
  });
});
