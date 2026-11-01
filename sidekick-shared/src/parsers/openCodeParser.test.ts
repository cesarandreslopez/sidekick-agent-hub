import { describe, expect, it } from 'vitest';
import {
  convertOpenCodeMessage,
  normalizeOpenCodeUsage,
  openCodeTokenCounts,
  openCodeTokenLayout,
  parseDbMessageData,
} from './openCodeParser';
import type { OpenCodeMessage } from '../types/opencode';

function assistant(tokens: Record<string, unknown>, providerID = 'openai'): OpenCodeMessage {
  return {
    id: 'msg_1',
    sessionID: 'ses_1',
    role: 'assistant',
    modelID: 'gpt-6-sol',
    providerID,
    tokens: tokens as OpenCodeMessage['tokens'],
    time: { created: 1785715730161, completed: 1785715731161 },
  };
}

describe('OpenCode token layouts', () => {
  it('treats the current layout (total = every bucket) as fully disjoint', () => {
    // A real stored row: 28185 + 4032 + 1655 + 160 = 34032.
    const counts = { input: 28185, output: 1655, reasoning: 160, cacheRead: 4032, total: 34032 };
    expect(openCodeTokenLayout(counts)).toEqual({
      inputIncludesCache: false,
      reasoningInOutput: false,
    });
    const usage = normalizeOpenCodeUsage(counts, 'openai');
    expect(usage.uncachedInputTokens).toBe(28185);
    expect(usage.billableOutputTokens).toBe(1655 + 160);
    expect(usage.totalTokens).toBe(34032);
  });

  it('assumes the current layout when no total is stored', () => {
    expect(openCodeTokenLayout({ input: 100, output: 50, reasoning: 20, cacheRead: 30 })).toEqual({
      inputIncludesCache: false,
      reasoningInOutput: false,
    });
  });

  it('recognizes reasoning counted inside output (before 2026-04)', () => {
    const counts = { input: 1000, output: 500, reasoning: 300, cacheRead: 200, total: 1700 };
    expect(openCodeTokenLayout(counts)).toEqual({
      inputIncludesCache: false,
      reasoningInOutput: true,
    });
    expect(normalizeOpenCodeUsage(counts, 'openai').billableOutputTokens).toBe(500);
  });

  it('recognizes cached input counted inside input (before 2025-11)', () => {
    const counts = { input: 1000, output: 500, reasoning: 0, cacheRead: 200, total: 1500 };
    expect(openCodeTokenLayout(counts)).toEqual({
      inputIncludesCache: true,
      reasoningInOutput: false,
    });
    expect(normalizeOpenCodeUsage(counts, 'openai').uncachedInputTokens).toBe(800);
  });

  it('no longer subtracts cache reads twice for OpenAI-provider messages', () => {
    const [event] = convertOpenCodeMessage(
      assistant({ input: 28185, output: 1655, reasoning: 160, cacheRead: 4032, total: 34032 }),
      [],
    ).filter((candidate) => candidate.message?.usage);
    expect(event.message?.usage?.input_tokens).toBe(28185);
    expect(event.message?.usage?.cache_read_input_tokens).toBe(4032);
  });

  it('reads cache counts from both storage shapes', () => {
    expect(
      openCodeTokenCounts({ input: 1, output: 2, cache: { read: 3, write: 4 } }),
    ).toMatchObject({ cacheRead: 3, cacheWrite: 4 });
    expect(openCodeTokenCounts({ input: 1, output: 2, cacheRead: 5, cacheWrite: 6 })).toMatchObject(
      { cacheRead: 5, cacheWrite: 6 },
    );
    const fileShape = convertOpenCodeMessage(
      assistant({ input: 10, output: 5, reasoning: 0, cache: { read: 7, write: 2 } }, 'anthropic'),
      [],
    ).find((candidate) => candidate.message?.usage);
    expect(fileShape?.message?.usage?.cache_read_input_tokens).toBe(7);
    expect(fileShape?.message?.usage?.cache_creation_input_tokens).toBe(2);
  });

  it('keeps the stored total when reading a database row', () => {
    const message = parseDbMessageData({
      id: 'msg_1',
      session_id: 'ses_1',
      time_created: 1,
      data: JSON.stringify({
        role: 'assistant',
        providerID: 'openai',
        tokens: {
          total: 34032,
          input: 28185,
          output: 1655,
          reasoning: 160,
          cache: { read: 4032, write: 0 },
        },
      }),
    } as Parameters<typeof parseDbMessageData>[0]);
    expect(message.tokens).toMatchObject({ total: 34032, cacheRead: 4032 });
  });
});
