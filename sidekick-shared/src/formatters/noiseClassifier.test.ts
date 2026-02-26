import { describe, it, expect } from 'vitest';
import {
  isHardNoise,
  isHardNoiseFollowEvent,
  getSoftNoiseReason,
  classifyMessage,
  classifyFollowEvent,
  shouldMergeWithPrevious,
  classifyNoise,
} from './noiseClassifier';
import type { SessionEvent } from '../types/sessionEvent';
import type { FollowEvent } from '../watchers/types';

function makeEvent(overrides: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return {
    message: { role: 'assistant', content: 'hello' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeFollowEvent(overrides: Partial<FollowEvent>): FollowEvent {
  return {
    providerId: 'claude-code',
    type: 'assistant',
    timestamp: new Date().toISOString(),
    summary: 'test',
    ...overrides,
  };
}

describe('isHardNoise', () => {
  it('marks sidechain events as hard noise', () => {
    expect(isHardNoise(makeEvent({ type: 'assistant', isSidechain: true }))).toBe(true);
  });

  it('does not mark normal assistant events as hard noise', () => {
    expect(isHardNoise(makeEvent({ type: 'assistant' }))).toBe(false);
  });

  it('marks synthetic model entries as hard noise', () => {
    expect(isHardNoise(makeEvent({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>test' },
    }))).toBe(true);
  });

  it('does not mark normal user events as hard noise', () => {
    expect(isHardNoise(makeEvent({ type: 'user', message: { role: 'user', content: 'hi' } }))).toBe(false);
  });
});

describe('isHardNoiseFollowEvent', () => {
  it('marks token count system events as hard noise', () => {
    expect(isHardNoiseFollowEvent(makeFollowEvent({
      type: 'system',
      summary: 'Tokens: 500 in / 100 out',
    }))).toBe(true);
  });

  it('marks model system events as hard noise', () => {
    expect(isHardNoiseFollowEvent(makeFollowEvent({
      type: 'system',
      summary: 'Model: claude-sonnet-4-20250514',
    }))).toBe(true);
  });

  it('keeps session ended system events', () => {
    expect(isHardNoiseFollowEvent(makeFollowEvent({
      type: 'system',
      summary: 'Session ended',
    }))).toBe(false);
  });

  it('keeps non-system events', () => {
    expect(isHardNoiseFollowEvent(makeFollowEvent({
      type: 'assistant',
      summary: 'hello',
    }))).toBe(false);
  });
});

describe('getSoftNoiseReason', () => {
  it('detects system-reminder tags', () => {
    expect(getSoftNoiseReason(makeEvent({
      type: 'user',
      message: { role: 'user', content: 'hello <system-reminder>secret</system-reminder> world' },
    }))).toBe('system-reminder');
  });

  it('detects empty tool outputs', () => {
    expect(getSoftNoiseReason(makeEvent({
      type: 'tool_result',
      result: { tool_use_id: 'abc', output: '' },
    }))).toBe('empty-tool-output');
  });

  it('detects interruption markers', () => {
    expect(getSoftNoiseReason(makeEvent({
      type: 'assistant',
      message: { role: 'assistant', content: 'Operation cancelled by user' },
    }))).toBe('interruption');
  });

  it('returns null for normal events', () => {
    expect(getSoftNoiseReason(makeEvent({
      type: 'assistant',
      message: { role: 'assistant', content: 'Here is the result' },
    }))).toBeNull();
  });
});

describe('classifyMessage', () => {
  it('classifies user messages', () => {
    expect(classifyMessage(makeEvent({ type: 'user', message: { role: 'user', content: 'hi' } }))).toBe('user');
  });

  it('classifies assistant messages', () => {
    expect(classifyMessage(makeEvent({ type: 'assistant' }))).toBe('ai');
  });

  it('classifies tool_use as ai', () => {
    expect(classifyMessage(makeEvent({ type: 'tool_use' }))).toBe('ai');
  });

  it('classifies tool_result as system', () => {
    expect(classifyMessage(makeEvent({ type: 'tool_result' }))).toBe('system');
  });

  it('classifies summary as compact', () => {
    expect(classifyMessage(makeEvent({ type: 'summary' }))).toBe('compact');
  });

  it('classifies teammate messages', () => {
    expect(classifyMessage(makeEvent({
      type: 'user',
      message: { role: 'user', content: '<teammate-message>Agent says hello</teammate-message>' },
    }))).toBe('teammate');
  });
});

describe('classifyFollowEvent', () => {
  it('classifies user events', () => {
    expect(classifyFollowEvent(makeFollowEvent({ type: 'user' }))).toBe('user');
  });

  it('classifies tool_use as ai', () => {
    expect(classifyFollowEvent(makeFollowEvent({ type: 'tool_use' }))).toBe('ai');
  });

  it('classifies summary as compact', () => {
    expect(classifyFollowEvent(makeFollowEvent({ type: 'summary' }))).toBe('compact');
  });
});

describe('shouldMergeWithPrevious', () => {
  it('merges consecutive assistant text messages', () => {
    const prev = makeEvent({ type: 'assistant', message: { role: 'assistant', content: 'part 1' } });
    const curr = makeEvent({ type: 'assistant', message: { role: 'assistant', content: 'part 2' } });
    expect(shouldMergeWithPrevious(curr, prev)).toBe(true);
  });

  it('does not merge when previous is null', () => {
    const curr = makeEvent({ type: 'assistant' });
    expect(shouldMergeWithPrevious(curr, null)).toBe(false);
  });

  it('does not merge different event types', () => {
    const prev = makeEvent({ type: 'user', message: { role: 'user', content: 'hi' } });
    const curr = makeEvent({ type: 'assistant' });
    expect(shouldMergeWithPrevious(curr, prev)).toBe(false);
  });

  it('does not merge when tool_use blocks present', () => {
    const prev = makeEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] as unknown },
    });
    const curr = makeEvent({ type: 'assistant', message: { role: 'assistant', content: 'text' } });
    expect(shouldMergeWithPrevious(curr, prev)).toBe(false);
  });
});

describe('classifyNoise', () => {
  it('returns full classification', () => {
    const result = classifyNoise(makeEvent({ type: 'assistant' }));
    expect(result.isHardNoise).toBe(false);
    expect(result.softNoiseReason).toBeNull();
    expect(result.messageClassification).toBe('ai');
  });

  it('detects hard noise + classification', () => {
    const result = classifyNoise(makeEvent({ type: 'assistant', isSidechain: true }));
    expect(result.isHardNoise).toBe(true);
    expect(result.messageClassification).toBe('ai');
  });
});
