import { describe, expect, it, vi } from 'vitest';

vi.mock('../cli', () => ({ resolveProvider: vi.fn() }));
import { resolveReportFlags } from './report';

describe('resolveReportFlags', () => {
  it('uses Commander normalized keys for both negated flags', () => {
    expect(resolveReportFlags({ open: false, thinking: false })).toEqual({
      noOpen: true,
      noThinking: true,
    });
    expect(resolveReportFlags({ open: true, thinking: true })).toEqual({
      noOpen: false,
      noThinking: false,
    });
  });
});
