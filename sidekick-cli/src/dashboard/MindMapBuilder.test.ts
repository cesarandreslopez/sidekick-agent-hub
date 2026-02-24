import { describe, it, expect } from 'vitest';
import { buildMindMapTree, renderMindMapAnsi, renderMindMapBoxed } from './MindMapBuilder';
import { shortenPath } from './formatters';
import type { DashboardMetrics } from './DashboardState';
import type { StaticData } from './StaticDataLoader';

function emptyMetrics(): DashboardMetrics {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    context: { used: 0, limit: 200000, percent: 0 },
    burnRate: [],
    toolStats: [],
    modelStats: [],
    timeline: [],
    tasks: [],
    fileTouches: [],
    subagents: [],
    compactionCount: 0,
    compactionEvents: [],
    quota: null,
    eventCount: 0,
    sessionStartTime: '2025-01-15T10:00:00Z',
    currentModel: 'claude-sonnet-4-5-20250514',
    providerId: 'claude-code',
    providerName: 'Claude Code',
    urls: [],
    directories: [],
    commands: [],
    todos: [],
    plan: null,
    contextAttribution: { systemPrompt: 0, userMessages: 0, assistantResponses: 0, toolInputs: 0, toolOutputs: 0, thinking: 0, other: 0 },
    updateInfo: null,
  };
}

function emptyStaticData(): StaticData {
  return {
    sessions: [],
    tasks: [],
    decisions: [],
    notes: [],
    plans: [],
    totalTokens: 0,
    totalCost: 0,
    totalSessions: 0,
  };
}

describe('shortenPath', () => {
  it('returns short paths unchanged', () => {
    expect(shortenPath('src/foo.ts')).toBe('src/foo.ts');
  });

  it('shortens long paths', () => {
    expect(shortenPath('/home/user/projects/my-app/src/services/AuthService.ts'))
      .toBe('.../src/services/AuthService.ts');
  });
});

describe('buildMindMapTree', () => {
  it('produces a tree with session root for empty metrics', () => {
    const tree = buildMindMapTree(emptyMetrics(), emptyStaticData());
    expect(tree.extended).toBe(true);
    const rootKeys = Object.keys(tree.children || {});
    expect(rootKeys.length).toBe(1);
    expect(rootKeys[0]).toContain('SESSION');
    expect(rootKeys[0]).toContain('2025-01-');
  });

  it('includes Tools section when tool stats exist', () => {
    const m = emptyMetrics();
    m.toolStats = [
      { name: 'Read', calls: 5, pending: 0 },
      { name: 'Write', calls: 3, pending: 1 },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const toolsKey = Object.keys(rootChildren).find(k => k.includes('Tools'));
    expect(toolsKey).toBeDefined();
    expect(toolsKey).toContain('2 types');
    expect(toolsKey).toContain('8 calls');
  });

  it('nests files under their tool', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 3, pending: 0 }];
    m.fileTouches = [
      { path: '/home/user/src/foo.ts', reads: 2, writes: 0, edits: 0 },
      { path: '/home/user/src/bar.ts', reads: 1, writes: 0, edits: 0 },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const toolsKey = Object.keys(rootChildren).find(k => k.includes('Tools'))!;
    const toolsSection = rootChildren[toolsKey];
    const readKey = Object.keys(toolsSection.children || {}).find(k => k.includes('Read'))!;
    const readNode = (toolsSection.children || {})[readKey];
    expect(readNode.children).toBeDefined();
    const fileKeys = Object.keys(readNode.children || {});
    expect(fileKeys.length).toBe(2);
    expect(fileKeys[0]).toContain('foo.ts');
  });

  it('includes Tasks section with status icons and cross-links', () => {
    const m = emptyMetrics();
    m.tasks = [
      { taskId: '1', subject: 'Set up project', status: 'completed', blockedBy: [], blocks: ['2'], toolCallCount: 3 },
      { taskId: '2', subject: 'Implement auth', status: 'in_progress', blockedBy: ['1'], blocks: [], toolCallCount: 5 },
      { taskId: '3', subject: 'Add tests', status: 'pending', blockedBy: [], blocks: [], toolCallCount: 0 },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const tasksKey = Object.keys(rootChildren).find(k => k.includes('Tasks'))!;
    expect(tasksKey).toContain('3');
    const taskChildren = rootChildren[tasksKey].children || {};
    const taskKeys = Object.keys(taskChildren);
    // Check status icons
    expect(taskKeys[0]).toContain('\u2713'); // completed
    expect(taskKeys[1]).toContain('\u2192'); // in_progress
    expect(taskKeys[2]).toContain('\u25CB'); // pending
    // Check cross-links
    expect(taskKeys[0]).toContain('blocks: #2');
    expect(taskKeys[1]).toContain('blocked by: #1');
  });

  it('includes Plan section with steps', () => {
    const m = emptyMetrics();
    m.plan = {
      title: 'Feature Implementation',
      steps: [
        { id: 's0', description: 'Design API schema', status: 'completed' },
        { id: 's1', description: 'Implement endpoints', status: 'in_progress' },
        { id: 's2', description: 'Integration tests', status: 'pending' },
      ],
    };
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const planKey = Object.keys(rootChildren).find(k => k.includes('Plan'))!;
    expect(planKey).toContain('Feature Implementation');
    expect(planKey).toContain('(1/3 33%)');
    const stepChildren = rootChildren[planKey].children || {};
    const stepKeys = Object.keys(stepChildren);
    expect(stepKeys.length).toBe(3);
    expect(stepKeys[0]).toContain('\u2713'); // completed
    expect(stepKeys[1]).toContain('\u2192'); // in_progress
  });

  it('includes Plan step → Task cross-references', () => {
    const m = emptyMetrics();
    m.plan = {
      title: 'Plan',
      steps: [{ id: 's0', description: 'Implement auth', status: 'in_progress' }],
    };
    m.tasks = [
      { taskId: '1', subject: 'Implement auth', status: 'in_progress', blockedBy: [], blocks: [], toolCallCount: 2 },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const planKey = Object.keys(rootChildren).find(k => k.includes('Plan'))!;
    const stepKeys = Object.keys(rootChildren[planKey].children || {});
    expect(stepKeys[0]).toContain('\u2192 Task #1');
  });

  it('includes Subagents section with status icons', () => {
    const m = emptyMetrics();
    m.subagents = [
      { id: 'tu1', description: 'Research auth patterns', subagentType: 'Explore', spawnTime: '2025-01-15T10:05:00Z', status: 'completed', completionTime: '2025-01-15T10:05:05Z', durationMs: 5000 },
      { id: 'tu2', description: 'Build integration', subagentType: 'Bash', spawnTime: '2025-01-15T10:06:00Z', status: 'running' },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const subKey = Object.keys(rootChildren).find(k => k.includes('Subagents'))!;
    expect(subKey).toContain('2');
    expect(subKey).toContain('1 running');
    const subChildren = rootChildren[subKey].children || {};
    const keys = Object.keys(subChildren);
    expect(keys[0]).toContain('Explore');
    expect(keys[0]).toContain('Research auth patterns');
    expect(keys[0]).toContain('\u2713'); // completed icon
    expect(keys[0]).toContain('5.0s'); // duration
    expect(keys[1]).toContain('\u21BB'); // running icon
  });

  it('includes TODOs section', () => {
    const m = emptyMetrics();
    m.todos = ['Add error handling', 'Refactor duplicate logic'];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const todoKey = Object.keys(rootChildren).find(k => k.includes('TODOs'))!;
    expect(todoKey).toContain('2');
  });

  it('includes Knowledge Notes section grouped by file', () => {
    const sd = emptyStaticData();
    sd.notes = [
      { filePath: 'src/auth.ts', noteType: 'gotcha', content: 'Watch for token expiry race condition', status: 'active', importance: 'high', id: '1', source: 'manual', createdAt: '', updatedAt: '', lastReviewedAt: '' },
      { filePath: 'src/auth.ts', noteType: 'pattern', content: 'Uses singleton pattern', status: 'active', importance: 'medium', id: '2', source: 'manual', createdAt: '', updatedAt: '', lastReviewedAt: '' },
    ] as StaticData['notes'];
    const tree = buildMindMapTree(emptyMetrics(), sd);
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const noteKey = Object.keys(rootChildren).find(k => k.includes('Knowledge Notes'))!;
    expect(noteKey).toContain('2');
  });

  it('includes URLs nested under URL tools', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'WebFetch', calls: 3, pending: 0 }];
    m.urls = [
      { url: 'https://github.com/some/repo', count: 2 },
      { url: 'https://docs.example.com/api', count: 1 },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const toolsKey = Object.keys(rootChildren).find(k => k.includes('Tools'))!;
    const toolsChildren = rootChildren[toolsKey].children || {};
    const fetchKey = Object.keys(toolsChildren).find(k => k.includes('WebFetch'))!;
    const fetchNode = toolsChildren[fetchKey];
    const urlKeys = Object.keys(fetchNode.children || {});
    expect(urlKeys.length).toBe(2);
    expect(urlKeys[0]).toContain('github.com');
  });

  it('includes commands nested under Bash tool', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Bash', calls: 6, pending: 0 }];
    m.commands = [
      { name: 'git', count: 4, examples: ['git status'] },
      { name: 'npm', count: 2, examples: ['npm test'] },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const toolsKey = Object.keys(rootChildren).find(k => k.includes('Tools'))!;
    const toolsChildren = rootChildren[toolsKey].children || {};
    const bashKey = Object.keys(toolsChildren).find(k => k.includes('Bash'))!;
    const bashNode = toolsChildren[bashKey];
    const cmdKeys = Object.keys(bashNode.children || {});
    expect(cmdKeys.length).toBe(2);
    expect(cmdKeys[0]).toContain('git');
  });

  it('includes directories nested under search tools', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Grep', calls: 5, pending: 0 }];
    m.directories = [
      { path: '/home/user/src/services', count: 3, patterns: ['buildGraph', 'extract*'] },
    ];
    const tree = buildMindMapTree(m, emptyStaticData());
    const rootChildren = Object.values(tree.children || {})[0]?.children || {};
    const toolsKey = Object.keys(rootChildren).find(k => k.includes('Tools'))!;
    const toolsChildren = rootChildren[toolsKey].children || {};
    const grepKey = Object.keys(toolsChildren).find(k => k.includes('Grep'))!;
    const grepNode = toolsChildren[grepKey];
    const dirKeys = Object.keys(grepNode.children || {});
    expect(dirKeys.length).toBe(1);
    expect(dirKeys[0]).toContain('services');
    expect(dirKeys[0]).toContain('buildGraph');
  });
});

describe('renderMindMapAnsi', () => {
  it('produces non-empty output for populated metrics', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 2, pending: 0 }];
    m.tasks = [
      { taskId: '1', subject: 'Test task', status: 'completed', blockedBy: [], blocks: [], toolCallCount: 1 },
    ];
    const lines = renderMindMapAnsi(m, emptyStaticData());
    expect(lines.length).toBeGreaterThan(0);
    // Should contain SESSION root
    expect(lines[0]).toContain('SESSION');
  });

  it('converts blessed color tags to ANSI codes', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 1, pending: 0 }];
    const lines = renderMindMapAnsi(m, emptyStaticData());
    const joined = lines.join('\n');
    // Should contain ANSI escape codes, not blessed tags
    expect(joined).not.toContain('{green-fg}');
    expect(joined).toContain('\x1b[');
  });

  it('produces empty output for empty metrics', () => {
    const lines = renderMindMapAnsi(emptyMetrics(), emptyStaticData());
    // Just the session root, no sections
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('SESSION');
  });
});

describe('renderMindMapBoxed', () => {
  it('renders session header with double-line box chars', () => {
    const lines = renderMindMapBoxed(emptyMetrics(), emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('╔');
    expect(joined).toContain('║');
    expect(joined).toContain('╚');
    expect(joined).toContain('SESSION');
  });

  it('renders tool section with single-line box chars', () => {
    const m = emptyMetrics();
    m.toolStats = [
      { name: 'Read', calls: 5, pending: 0 },
      { name: 'Write', calls: 3, pending: 0 },
    ];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('┌');
    expect(joined).toContain('┐');
    expect(joined).toContain('└');
    expect(joined).toContain('┘');
    expect(joined).toContain('TOOLS');
    expect(joined).toContain('2 types');
    expect(joined).toContain('8 total calls');
    expect(joined).toContain('Read');
    expect(joined).toContain('Write');
  });

  it('renders tasks section with status icons and cross-links', () => {
    const m = emptyMetrics();
    m.tasks = [
      { taskId: '1', subject: 'Set up project', status: 'completed', blockedBy: [], blocks: ['3'], toolCallCount: 3 },
      { taskId: '2', subject: 'Implement auth', status: 'in_progress', blockedBy: [], blocks: [], toolCallCount: 5 },
      { taskId: '3', subject: 'Add tests', status: 'pending', blockedBy: ['1'], blocks: [], toolCallCount: 0 },
    ];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('TASKS');
    expect(joined).toMatch(/v Set up project/);   // completed
    expect(joined).toMatch(/> Implement auth/);    // in_progress
    expect(joined).toMatch(/o Add tests/);         // pending
    // Two-column layout: call count right-aligned
    expect(joined).toContain('3 calls');
    expect(joined).toContain('5 calls');
  });

  it('renders stem connectors between sections', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 2, pending: 0 }];
    m.tasks = [
      { taskId: '1', subject: 'A task', status: 'pending', blockedBy: [], blocks: [], toolCallCount: 0 },
    ];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    // There should be a stem line (just spaces + │) between session header and first section,
    // and between the two sections
    const stemLines = lines.filter(l => l.trim() === '│');
    expect(stemLines.length).toBeGreaterThanOrEqual(2);
  });

  it('skips empty sections', () => {
    const m = emptyMetrics();
    // Only tools, no tasks/plan/subagents/todos/notes
    m.toolStats = [{ name: 'Read', calls: 1, pending: 0 }];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('TOOLS');
    expect(joined).not.toContain('TASKS');
    expect(joined).not.toContain('PLAN');
    expect(joined).not.toContain('SUBAGENTS');
    expect(joined).not.toContain('TODOs');
    expect(joined).not.toContain('KNOWLEDGE NOTES');
  });

  it('renders plan section with step cross-references', () => {
    const m = emptyMetrics();
    m.plan = {
      title: 'Feature Implementation',
      steps: [
        { id: 's0', description: 'Design API', status: 'completed' },
        { id: 's1', description: 'Implement auth', status: 'in_progress' },
      ],
    };
    m.tasks = [
      { taskId: '1', subject: 'Implement auth', status: 'in_progress', blockedBy: [], blocks: [], toolCallCount: 2 },
    ];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('PLAN');
    expect(joined).toContain('Feature Implement'); // truncated in subtitle
    expect(joined).toContain('T#1');
  });

  it('renders subagents section with status and duration', () => {
    const m = emptyMetrics();
    m.subagents = [
      { id: 'tu1', description: 'Research patterns', subagentType: 'Explore', spawnTime: '2025-01-15T10:00:00Z', status: 'completed', completionTime: '2025-01-15T10:00:03Z', durationMs: 3000 },
      { id: 'tu2', description: 'Run tests', subagentType: 'Bash', spawnTime: '2025-01-15T10:01:00Z', status: 'running' },
    ];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('SUBAGENTS');
    expect(joined).toContain('Explore');
    expect(joined).toContain('Research patterns');
    expect(joined).toContain('3.0s');
    expect(joined).toContain('1 running');
  });

  it('renders TODOs section', () => {
    const m = emptyMetrics();
    m.todos = ['Add error handling', 'Refactor logic'];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('TODOs');
    expect(joined).toContain('Add error handling');
  });

  it('renders knowledge notes section', () => {
    const sd = emptyStaticData();
    sd.notes = [
      { filePath: 'src/auth.ts', noteType: 'gotcha', content: 'Token expiry race condition', status: 'active', importance: 'high', id: '1', source: 'manual', createdAt: '', updatedAt: '', lastReviewedAt: '' },
    ] as StaticData['notes'];
    const lines = renderMindMapBoxed(emptyMetrics(), sd);
    const joined = lines.join('\n');
    expect(joined).toContain('KNOWLEDGE NOTES');
    expect(joined).toContain('[!]');
    expect(joined).toContain('Token expiry');
  });

  it('includes file and tool counts in session header', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 15, pending: 0 }];
    m.fileTouches = [
      { path: 'foo.ts', reads: 3, writes: 0, edits: 0 },
      { path: 'bar.ts', reads: 1, writes: 0, edits: 0 },
    ];
    m.tasks = [
      { taskId: '1', subject: 'Task', status: 'pending', blockedBy: [], blocks: [], toolCallCount: 0 },
    ];
    const lines = renderMindMapBoxed(m, emptyStaticData());
    const joined = lines.join('\n');
    expect(joined).toContain('2 files');
    expect(joined).toContain('15 tool calls');
    expect(joined).toContain('1 tasks');
  });

  it('emits blessed tags when blessedTags option is set', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 3, pending: 0 }];
    const lines = renderMindMapBoxed(m, emptyStaticData(), { blessedTags: true, center: false });
    const joined = lines.join('\n');
    expect(joined).toContain('{green-fg}');
    expect(joined).toContain('{/green-fg}');
    // Should NOT contain ANSI escape codes
    expect(joined).not.toContain('\x1b[');
  });

  it('skips centering when center is false', () => {
    const lines = renderMindMapBoxed(emptyMetrics(), emptyStaticData(), { center: false });
    // First line should start with the box character, no leading spaces
    expect(lines[0]).toMatch(/^╔/);
  });

  it('respects columns for box width', () => {
    const m = emptyMetrics();
    m.toolStats = [{ name: 'Read', calls: 1, pending: 0 }];
    // Small columns → narrow box
    const lines = renderMindMapBoxed(m, emptyStaticData(), { columns: 30, center: false });
    // Box width = min(30 - 8, 50) = 22, so lines should be 22 chars wide
    const headerLine = lines[0]; // ╔═══...═══╗
    expect(headerLine.length).toBe(22);
  });
});
