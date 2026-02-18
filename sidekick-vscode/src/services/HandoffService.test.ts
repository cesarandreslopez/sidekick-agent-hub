import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode
vi.mock('vscode', () => ({
  default: {},
  Disposable: class { dispose() {} },
}));

import { HandoffService } from './HandoffService';
import type { SessionSummaryData } from '../types/sessionSummary';
import type { SessionAnalysisData } from '../types/analysis';
import type { SessionStats } from '../types/claudeSession';

const TEST_DIR = path.join(os.tmpdir(), 'sidekick-handoff-test-' + Date.now());

function makeSummary(overrides?: Partial<SessionSummaryData>): SessionSummaryData {
  return {
    duration: 3600000,
    totalTokens: 50000,
    totalCost: 1.5,
    contextPeak: 85,
    apiCalls: 100,
    tasks: [
      { subject: 'Fix auth bug', status: 'completed', duration: 1200000, toolCallCount: 10, estimatedCost: 0.5 },
      { subject: 'Add tests', status: 'pending', duration: 600000, toolCallCount: 5, estimatedCost: 0.3 },
    ],
    taskCompletionRate: 0.5,
    filesChanged: [
      { path: 'src/auth.ts', additions: 20, deletions: 5 },
      { path: 'src/tests/auth.test.ts', additions: 50, deletions: 0 },
    ],
    totalFilesChanged: 2,
    totalAdditions: 70,
    totalDeletions: 5,
    costByModel: [],
    costByTool: [],
    errors: [],
    recoveryRate: 0,
    ...overrides,
  };
}

function makeAnalysis(overrides?: Partial<SessionAnalysisData>): SessionAnalysisData {
  return {
    errors: [
      { category: 'exit_code', count: 2, examples: ['npm install failed'] },
    ],
    toolPatterns: [],
    inefficiencies: [],
    recoveryPatterns: [
      {
        type: 'command_fallback',
        description: 'pnpm works',
        failedApproach: 'npm install',
        successfulApproach: 'pnpm install',
        occurrences: 1,
      },
    ],
    recentActivity: [],
    sessionDuration: 3600000,
    totalTokens: 50000,
    projectPath: '/home/user/my-project',
    hasEnoughData: true,
    ...overrides,
  };
}

function makeStats(): SessionStats {
  return {
    totalInputTokens: 30000,
    totalOutputTokens: 20000,
    totalCacheWriteTokens: 0,
    totalCacheReadTokens: 0,
    totalReportedCost: 1.5,
    apiCalls: 100,
    sessionPath: '/tmp/session.jsonl',
    sessionStartTime: new Date(),
    currentContextSize: 50000,
    toolCalls: [],
    timeline: [],
    modelUsage: {},
    pendingToolCalls: new Map(),
    subagentStats: new Map(),
    taskState: { tasks: [], lastUpdated: null, activePlan: null },
    pendingUserRequests: [],
    responseLatency: { measurements: [], totalMeasurements: 0 },
    compactionEvents: [],
    contextAttribution: null,
    lastKnownModelId: null,
  };
}

describe('HandoffService', () => {
  let service: HandoffService;

  beforeEach(() => {
    // Use a temp dir to avoid polluting ~/.config/sidekick
    service = new HandoffService('test-project');
    // Override the private handoffsDir
    (service as unknown as { handoffsDir: string }).handoffsDir = TEST_DIR;
  });

  afterEach(() => {
    service.dispose();
    // Clean up
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('creates handoff directory on initialize', async () => {
    await service.initialize();
    // After initialize, the directory should exist
    expect(fs.existsSync(TEST_DIR)).toBe(true);
  });

  it('generates handoff and writes latest file', async () => {
    await service.initialize();
    const handoffPath = await service.generateHandoff(makeSummary(), makeAnalysis(), makeStats());

    expect(handoffPath).toContain('test-project-latest.md');
    expect(fs.existsSync(handoffPath)).toBe(true);

    const content = fs.readFileSync(handoffPath, 'utf-8');
    expect(content).toContain('# Session Handoff: my-project');
    expect(content).toContain('## Pending Tasks');
    expect(content).toContain('Add tests');
    // Should NOT include completed tasks
    expect(content).not.toContain('Fix auth bug');
  });

  it('generates timestamped copy', async () => {
    await service.initialize();
    await service.generateHandoff(makeSummary(), makeAnalysis(), makeStats());

    const dateStr = new Date().toISOString().slice(0, 10);
    const timestampedPath = path.join(TEST_DIR, `test-project-${dateStr}.md`);
    expect(fs.existsSync(timestampedPath)).toBe(true);
  });

  it('getLatestHandoffPath returns null when no handoff exists', () => {
    expect(service.getLatestHandoffPath()).toBeNull();
  });

  it('getLatestHandoffPath returns path after generation', async () => {
    await service.initialize();
    await service.generateHandoff(makeSummary(), makeAnalysis(), makeStats());
    const latestPath = service.getLatestHandoffPath();
    expect(latestPath).not.toBeNull();
    expect(latestPath).toContain('latest.md');
  });

  it('readLatestHandoff returns content after generation', async () => {
    await service.initialize();
    await service.generateHandoff(makeSummary(), makeAnalysis(), makeStats());
    const content = await service.readLatestHandoff();
    expect(content).not.toBeNull();
    expect(content).toContain('# Session Handoff');
  });

  it('readLatestHandoff returns null when no handoff exists', async () => {
    const content = await service.readLatestHandoff();
    expect(content).toBeNull();
  });

  it('includes recovery patterns in handoff', async () => {
    await service.initialize();
    await service.generateHandoff(makeSummary(), makeAnalysis(), makeStats());
    const content = await service.readLatestHandoff();
    expect(content).toContain('pnpm install');
  });

  it('includes failed commands in handoff', async () => {
    await service.initialize();
    await service.generateHandoff(makeSummary(), makeAnalysis(), makeStats());
    const content = await service.readLatestHandoff();
    expect(content).toContain('npm install failed');
  });
});
