import { describe, expect, it } from 'vitest';
import type { SessionProviderBase } from '../providers/types';
import type { SessionEvent } from '../types/sessionEvent';
import {
  buildSessionContextSnapshot,
  calculateSessionContextPressure,
  createSessionContextProjector,
  readSessionContextSnapshot,
} from './sessionContext';

const ts = '2026-06-04T12:00:00.000Z';

function event(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: 'hello' },
    ...overrides,
  } as SessionEvent;
}

function richEvents(): SessionEvent[] {
  return [
    event({
      type: 'system',
      message: {
        role: 'system',
        id: 'base',
        sourceLabel: 'base instructions',
        content: [{ type: 'text', text: 'Follow repository instructions.' }],
      },
    }),
    event({
      type: 'user',
      message: {
        role: 'user',
        id: 'u1',
        content: [{ type: 'text', text: 'Please inspect src/app.ts.' }],
      },
    }),
    event({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'a1',
        model: 'gpt-5-codex',
        content: [
          { type: 'thinking', thinking: 'Need to inspect the file first.' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'src/app.ts' },
          },
          { type: 'text', text: 'I will check the file.' },
        ],
      },
    }),
    event({
      type: 'user',
      message: {
        role: 'user',
        id: 'tool-1:result',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'export function main() { return true; }',
          },
        ],
      },
    }),
    event({
      type: 'system',
      rateLimits: {
        primary: { usedPercent: 82, windowMinutes: 300, resetsAt: 1760000000 },
      },
      message: {
        role: 'system',
        id: 'tokens',
        model: 'gpt-5-codex',
        usage: {
          input_tokens: 820,
          output_tokens: 40,
          cache_read_input_tokens: 10,
          reasoning_tokens: 12,
        },
        content: [],
      },
    }),
  ];
}

describe('calculateSessionContextPressure', () => {
  it('maps token pressure to low, medium, and high', () => {
    expect(calculateSessionContextPressure(100, 1000)).toEqual({ pressure: 'low', ratio: 0.1 });
    expect(calculateSessionContextPressure(600, 1000)).toEqual({ pressure: 'medium', ratio: 0.6 });
    expect(calculateSessionContextPressure(800, 1000)).toEqual({ pressure: 'high', ratio: 0.8 });
  });
});

describe('buildSessionContextSnapshot', () => {
  it('extracts provider-neutral context evidence from canonical events', () => {
    const snapshot = buildSessionContextSnapshot(richEvents(), {
      providerId: 'codex',
      providerLabel: 'Codex',
      sessionId: 'session-1',
      sessionPath: '/tmp/session.jsonl',
      contextWindow: 1000,
      computeContextSize: usage => usage.inputTokens,
    });

    expect(snapshot.providerId).toBe('codex');
    expect(snapshot.sessionId).toBe('session-1');
    expect(snapshot.model).toBe('gpt-5-codex');
    expect(snapshot.contextTokens).toBe(820);
    expect(snapshot.pressure).toBe('high');
    expect(snapshot.pressureRatio).toBe(0.82);
    expect(snapshot.layers).toEqual(expect.arrayContaining(['system', 'user', 'tool inputs', 'runtime']));
    expect(snapshot.capabilities).toMatchObject({
      providerId: 'codex',
      providerLabel: 'Codex',
      model: 'gpt-5-codex',
      observedTools: ['Read'],
      rateLimits: {
        primary: { usedPercent: 82, windowMinutes: 300, resetsAt: 1760000000 },
      },
    });

    const fileSource = snapshot.sources.find(source => source.sourceFile === 'src/app.ts');
    expect(fileSource).toMatchObject({
      sourceType: 'tool_input',
      layer: 'tool inputs',
      title: 'Read: src/app.ts',
      toolName: 'Read',
      body: undefined,
    });
    expect(snapshot.sources.some(source => source.title === 'base instructions')).toBe(true);
    expect(snapshot.sources.some(source => source.sourceType === 'tool_output')).toBe(true);
    expect(snapshot.breakdown.some(row => row.layer === 'tool inputs' && row.sourceCount === 1)).toBe(true);
  });

  it('includes bounded bodies only when requested', () => {
    const snapshot = buildSessionContextSnapshot(
      [
        event({
          type: 'user',
          message: {
            role: 'user',
            content: 'x'.repeat(100),
          },
        }),
      ],
      {
        includeBodies: true,
        bodyMaxChars: 20,
        snippetMaxChars: 12,
      },
    );

    expect(snapshot.sources[0].snippet).toBe('xxxxxxxxx...');
    expect(snapshot.sources[0].body).toBe('xxxxxxxxxxxxxxxxx...');
    expect(snapshot.sources[0].metadata).toMatchObject({
      bodyTruncated: true,
      originalChars: 100,
    });
  });

  it('keeps system/runtime evidence while limiting latest sources', () => {
    const manyEvents: SessionEvent[] = [
      event({
        type: 'system',
        message: { role: 'system', sourceLabel: 'developer', content: 'rules' },
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        event({
          type: 'user',
          timestamp: `2026-06-04T12:00:0${i}.000Z`,
          message: { role: 'user', content: `prompt ${i}` },
        }),
      ),
    ];

    const snapshot = buildSessionContextSnapshot(manyEvents, { sourceLimit: 4 });
    expect(snapshot.sources).toHaveLength(4);
    expect(snapshot.sources.some(source => source.sourceType === 'system')).toBe(true);
    expect(snapshot.sources.at(-1)?.snippet).toBe('prompt 7');
  });
});

describe('createSessionContextProjector', () => {
  it('updates a snapshot incrementally', () => {
    const projector = createSessionContextProjector({
      providerId: 'claude-code',
      contextWindow: 100,
    });

    projector.processEvent(event({ message: { role: 'user', content: 'hello world' } }));
    const snapshot = projector.processEvent(
      event({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-20250514',
          content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      }),
    );

    expect(snapshot.capabilities.observedTools).toEqual(['Read']);
    expect(snapshot.sources.some(source => source.sourceFile === 'a.ts')).toBe(true);

    projector.reset();
    expect(projector.getSnapshot().sources).toEqual([]);
  });
});

describe('readSessionContextSnapshot', () => {
  it('reads through a SessionProviderBase reader and provider context sizing', () => {
    const events = richEvents();
    const provider = {
      id: 'codex',
      displayName: 'Codex',
      getSessionId: () => 'abc',
      createReader: () => ({
        readNew: () => events,
        readAll: () => events,
        reset: () => undefined,
        exists: () => true,
        flush: () => undefined,
        getPosition: () => 0,
        seekTo: () => undefined,
        wasTruncated: () => false,
      }),
      getContextWindowLimit: () => 1000,
      computeContextSize: usage => usage.inputTokens,
    } as unknown as SessionProviderBase;

    const snapshot = readSessionContextSnapshot(provider, '/tmp/rollout.jsonl');
    expect(snapshot.providerId).toBe('codex');
    expect(snapshot.sessionId).toBe('abc');
    expect(snapshot.sessionPath).toBe('/tmp/rollout.jsonl');
    expect(snapshot.contextWindow).toBe(1000);
    expect(snapshot.pressure).toBe('high');
  });
});
