/**
 * `extractSessionEvents` parses a line with only its `type`'s schema. That
 * must give exactly what parsing with the whole `sessionEventSchema` union
 * gave, for every kind of line, valid or not.
 */
import { describe, expect, it } from 'vitest';
import { extractSessionEvents, sessionEventSchema } from './sessionEvent';

const base = { timestamp: '2026-11-01T12:00:00Z', cwd: '/w', gitBranch: 'main' };
const message = (role: string, extra: Record<string, unknown> = {}) => ({
  role,
  content: 'hi',
  ...extra,
});

/** The compact-boundary copy `extractSessionEvents` applies first (as in the module). */
function withCompactBoundaryCounts(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const line = raw as Record<string, unknown>;
  if (line.type !== 'system' || line.subtype !== 'compact_boundary' || line.compaction) return raw;
  const metadata = line.compactMetadata as Record<string, unknown> | undefined;
  if (!metadata) return raw;
  const { preTokens, postTokens, trigger } = metadata;
  if (!Number.isInteger(preTokens) || !Number.isInteger(postTokens)) return raw;
  return {
    ...line,
    compaction: { tokensBefore: preTokens, tokensAfter: postTokens, trigger },
  };
}

/** The direct parse as it was: the whole union. */
function unionParse(raw: unknown): unknown {
  const parsed = sessionEventSchema.safeParse(withCompactBoundaryCounts(raw));
  return parsed.success ? parsed.data : null;
}

const CORPUS: Array<[string, unknown]> = [
  ['user', { ...base, type: 'user', message: message('user'), permissionMode: 'auto' }],
  [
    'user with unknown mode',
    { ...base, type: 'user', message: message('user'), permissionMode: 'x' },
  ],
  ['user without message', { ...base, type: 'user' }],
  [
    'assistant',
    {
      ...base,
      type: 'assistant',
      message: message('assistant', {
        id: 'm1',
        model: 'claude-sonnet-4-5',
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    },
  ],
  [
    'assistant with bad usage',
    { ...base, type: 'assistant', message: message('assistant', { usage: { input_tokens: 'x' } }) },
  ],
  ['summary with message', { ...base, type: 'summary', message: message('system') }],
  ['summary with text', { ...base, type: 'summary', summary: 'compacted' }],
  [
    'summary with compaction',
    { ...base, type: 'summary', compaction: { tokensBefore: 100, tokensAfter: 10 } },
  ],
  [
    'summary with inverted compaction',
    { ...base, type: 'summary', compaction: { tokensBefore: 10, tokensAfter: 100 } },
  ],
  ['empty summary', { ...base, type: 'summary' }],
  ['system', { ...base, type: 'system', subtype: 'turn_duration' }],
  [
    'compact boundary',
    {
      ...base,
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { preTokens: 1000, postTokens: 100, trigger: 'auto' },
    },
  ],
  ['tool_use', { ...base, type: 'tool_use', tool: { name: 'Read', input: { file_path: '/a' } } }],
  ['tool_use without tool', { ...base, type: 'tool_use' }],
  ['tool_result', { ...base, type: 'tool_result', result: { tool_use_id: 't1', output: 'ok' } }],
  ['attachment', { ...base, type: 'attachment', attachment: { type: 'file', content: 'x' } }],
  ['queue-operation', { ...base, type: 'queue-operation', operation: 'enqueue' }],
  ['api-request-blob', { ...base, type: 'api-request-blob', blob: 'x'.repeat(100) }],
  [
    'progress',
    {
      ...base,
      type: 'progress',
      data: { message: { ...base, type: 'assistant', message: message('assistant') } },
    },
  ],
  ['constructor type', { ...base, type: 'constructor', message: message('user') }],
  ['toString type', { ...base, type: 'toString', message: message('user') }],
  ['__proto__ type', { ...base, type: '__proto__', message: message('user') }],
  ['numeric type', { ...base, type: 7, message: message('user') }],
  ['no type', { ...base, message: message('user') }],
  ['missing timestamp', { type: 'user', message: message('user') }],
  ['array', [1, 2, 3]],
  ['string', 'user'],
  ['number', 42],
  ['null', null],
];

describe('session event parsing by type', () => {
  it.each(CORPUS)('%s parses as the union did', (_name, raw) => {
    const events = extractSessionEvents(raw);
    const direct = unionParse(raw);
    if (direct !== null) {
      expect(events).toEqual([direct]);
    } else if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as { type?: unknown }).type !== 'progress'
    ) {
      expect(events).toEqual([]);
    }
  });

  it('keeps unwrapping progress envelopes', () => {
    const raw = CORPUS.find(([name]) => name === 'progress')![1];
    const [event] = extractSessionEvents(raw);
    expect(event.type).toBe('assistant');
    expect(event.cwd).toBe('/w');
  });

  it('copies compact-boundary counts before dispatching', () => {
    const raw = CORPUS.find(([name]) => name === 'compact boundary')![1];
    const [event] = extractSessionEvents(raw);
    expect(event.compaction).toEqual({ tokensBefore: 1000, tokensAfter: 100, trigger: 'auto' });
  });
});
