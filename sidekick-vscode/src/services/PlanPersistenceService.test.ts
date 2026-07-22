import { describe, expect, it, vi } from 'vitest';
import type { PlanState } from '../types/claudeSession';

vi.mock('vscode', () => ({}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock('sidekick-shared', () => ({
  updateJsonStoreAtomic: async <T>(
    _filePath: string,
    createEmpty: () => T,
    mutate: (store: T) => T,
  ) => mutate(createEmpty()),
  atomicWriteJsonSync: vi.fn(),
}));

import { PlanPersistenceService } from './PlanPersistenceService';

function untitledPlan(description: string): PlanState {
  return {
    active: false,
    source: 'claude-code',
    title: undefined,
    rawMarkdown: description,
    steps: [{ id: 'one', description, status: 'completed' }],
  } as PlanState;
}

describe('PlanPersistenceService', () => {
  it('updates one normalized untitled plan per session', async () => {
    const service = new PlanPersistenceService('project');

    service.savePlan('session-1', untitledPlan('first'));
    service.savePlan('session-1', untitledPlan('updated'));

    expect(service.getPlans()).toHaveLength(1);
    expect(service.getPlans()[0]).toMatchObject({
      sessionId: 'session-1',
      title: 'Untitled Plan',
      rawMarkdown: 'updated',
    });
    await service.forceSave();
  });
});
