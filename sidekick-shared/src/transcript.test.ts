import { describe, expect, it } from 'vitest';
import { EventAggregator } from './aggregation/EventAggregator';
import { CodexRolloutParser } from './parsers/codexParser';
import { projectSessionTranscript } from './transcript';
import { calculateNormalizedUsageCost, extractNormalizedUsage } from './usageNormalization';
import type { CodexRolloutLine } from './types/codex';
import type { SessionEvent } from './types/sessionEvent';

describe('projectSessionTranscript', () => {
  it('bounds snippets and preserves full-fidelity tool content on request', () => {
    const events: SessionEvent[] = [
      {
        type: 'assistant',
        timestamp: '2026-07-22T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'abcdefghij' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'Bash',
              input: { command: 'npm test', detail: 'long detail' },
            },
          ],
        },
      },
      {
        type: 'tool_result',
        timestamp: '2026-07-22T00:00:01Z',
        result: { tool_use_id: 'call-1', output: 'all passing', is_error: false },
      },
    ];

    const snippet = projectSessionTranscript(events, { maxContentChars: 5 });
    expect(snippet.messages[0].content[0]).toMatchObject({ text: 'abcde', truncated: true });
    expect(snippet.commands).toEqual(['npm test']);
    expect(snippet.tools[0]).toMatchObject({ output: 'all p', isError: false });

    const full = projectSessionTranscript(events, { fidelity: 'full' });
    expect(full.messages[0].content[0]).toMatchObject({ text: 'abcdefghij', truncated: false });
    expect(full.tools[0].input).toEqual({ command: 'npm test', detail: 'long detail' });
    expect(full.tools[0].output).toBe('all passing');
  });

  it('keeps Codex normalization and cost identical across all public paths', () => {
    const parser = new CodexRolloutParser();
    parser.convertLine({
      timestamp: '2026-07-22T00:00:00Z',
      type: 'turn_context',
      payload: { model: 'gpt-4o' },
    } as CodexRolloutLine);
    const events = parser.convertLine({
      timestamp: '2026-07-22T00:00:01Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 300,
            output_tokens: 200,
            reasoning_output_tokens: 40,
          },
        },
      },
    } as CodexRolloutLine);
    const normalized = extractNormalizedUsage(events[0]);
    expect(normalized).toMatchObject({
      uncachedInputTokens: 700,
      cacheReadTokens: 300,
      outputTokens: 200,
      reasoningTokens: 40,
      reasoningIncludedInOutput: true,
      cacheInclusiveInputTokens: 1000,
      billableOutputTokens: 200,
      totalTokens: 1200,
    });

    const publicCost = calculateNormalizedUsageCost({ usage: normalized!, modelId: 'gpt-4o' });
    const aggregator = new EventAggregator();
    events.forEach((event) => aggregator.processEvent(event));
    const transcript = projectSessionTranscript(events, { provider: 'codex' });
    const transcriptWithProvenance = projectSessionTranscript(
      events.map((event) => ({
        ...event,
        entrypoint: 'cli',
        isMeta: false,
        isSidechain: false,
        cwd: '/workspace/app',
        gitBranch: 'main',
      })),
      { provider: 'codex' },
    );

    expect(aggregator.getAggregatedTokens()).toMatchObject({
      inputTokens: 700,
      cacheReadTokens: 300,
      outputTokens: 200,
      reasoningTokens: 40,
      totalTokens: 1200,
    });
    expect(aggregator.getModelStats()[0].cost).toBeCloseTo(publicCost.costUsd!);
    expect(transcript.usage.totals).toMatchObject({
      uncachedInputTokens: 700,
      cacheReadTokens: 300,
      outputTokens: 200,
      reasoningTokens: 40,
      totalTokens: 1200,
    });
    expect(transcript.usage.totalCostUsd).toBeCloseTo(publicCost.costUsd!);
    expect(transcriptWithProvenance.usage).toEqual(transcript.usage);
  });

  it('retains message-less summaries in the canonical transcript', () => {
    const transcript = projectSessionTranscript([
      {
        type: 'summary',
        timestamp: '2026-07-22T00:00:00Z',
        compaction: { tokensBefore: 10_000, tokensAfter: 4_000 },
      },
    ]);

    expect(transcript.messages).toEqual([
      expect.objectContaining({
        role: 'summary',
        text: '',
        content: [],
        source: expect.objectContaining({ eventType: 'summary', originalRole: undefined }),
      }),
    ]);
  });

  it('uses the most recent non-empty cwd and git branch', () => {
    const transcript = projectSessionTranscript([
      {
        type: 'user',
        timestamp: '2026-07-22T00:00:00Z',
        cwd: '/workspace/app',
        gitBranch: 'main',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-22T00:00:01Z',
        cwd: '',
        gitBranch: '   ',
        message: { role: 'assistant', content: 'hi' },
      },
    ]);

    expect(transcript).toMatchObject({ cwd: '/workspace/app', gitBranch: 'main' });
  });

  it('projects Codex cwd and preserves developer and system original roles', () => {
    const parser = new CodexRolloutParser();
    const events: SessionEvent[] = [];
    events.push(
      ...parser.convertLine({
        timestamp: '2026-07-22T00:00:00Z',
        type: 'session_meta',
        payload: { id: 'session-1', cwd: '/workspace/app' },
      }),
      ...parser.convertLine({
        timestamp: '2026-07-22T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Developer instructions' }],
        },
      }),
      ...parser.convertLine({
        timestamp: '2026-07-22T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'System instructions' }],
        },
      }),
    );

    const transcript = projectSessionTranscript(events, { provider: 'codex' });
    expect(transcript.cwd).toBe('/workspace/app');
    expect(transcript.messages.map((message) => message.source.originalRole)).toEqual([
      'developer',
      'system',
    ]);
  });
});
