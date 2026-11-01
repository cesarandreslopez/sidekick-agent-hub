import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readAgentMeta, scanSubagentDir } from './subagentScanner';
import { scanSubagentTraces, type SubagentTrace } from './subagentTraceParser';

const roots: string[] = [];

function writeAgent(root: string, id: string, lines: unknown[]): void {
  const dir = path.join(root, 'session', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map(JSON.stringify).join('\n'));
}

function writeMeta(root: string, id: string, meta: unknown): void {
  const dir = path.join(root, 'session', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-subagent-'));
  roots.push(root);
  return root;
}

function spawnLine(timestamp: string, toolUseId: string, name = 'Agent'): unknown {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input: { description: 'child' } }],
    },
  };
}

function textLine(timestamp: string, text = 'working'): unknown {
  return { type: 'assistant', timestamp, message: { role: 'assistant', content: text } };
}

function flatten(traces: SubagentTrace[]): SubagentTrace[] {
  return traces.flatMap((trace) => [trace, ...flatten(trace.children)]);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('subagent parsers', () => {
  it('emits assistant tool summaries and uses fresh input-token semantics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-subagent-'));
    roots.push(root);
    writeAgent(root, 'child', [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a' } }],
        },
      },
    ]);
    expect(scanSubagentDir(root, 'session')[0].inputTokens).toBe(10);
    const trace = scanSubagentTraces(root, 'session')[0];
    expect(trace.stats.inputTokens).toBe(10);
    expect(trace.events[0].toolSummary).toBe('a');
  });

  it('links a nearby child to an assistant Task event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-subagent-'));
    roots.push(root);
    writeAgent(root, 'parent', [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Task', input: { description: 'child' } }],
        },
      },
    ]);
    writeAgent(root, 'child', [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: 'working' },
      },
    ]);
    const traces = scanSubagentTraces(root, 'session');
    const parent = traces.find((trace) => trace.agentId === 'parent');
    expect(parent?.children.map((child) => child.agentId)).toEqual(['child']);
  });

  it('skips already-consumed agent files before parsing them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-subagent-'));
    roots.push(root);
    writeAgent(root, 'old', [{ type: 'assistant', message: { usage: { input_tokens: 1 } } }]);
    writeAgent(root, 'new', [{ type: 'assistant', message: { usage: { input_tokens: 2 } } }]);

    const stats = scanSubagentDir(root, 'session', undefined, new Set(['agent-old.jsonl']));

    expect(stats.map((agent) => agent.agentId)).toEqual(['new']);
  });

  it('links a nearby child to an assistant Agent event without spawn metadata', () => {
    const root = tempRoot();
    writeAgent(root, 'parent', [spawnLine('2026-01-01T00:00:00.000Z', 'toolu_x')]);
    writeAgent(root, 'child', [textLine('2026-01-01T00:00:01.000Z')]);
    const traces = scanSubagentTraces(root, 'session');
    expect(traces.map((trace) => trace.agentId)).toEqual(['parent']);
    const [child] = traces[0].children;
    expect(child).toMatchObject({ agentId: 'child', parentAgentId: 'parent' });
    // Heuristic links keep the old value: the parent's agent id.
    expect(child.parentToolUseId).toBe('parent');
  });
});

describe('readAgentMeta', () => {
  it('returns every well-typed field', () => {
    const root = tempRoot();
    writeAgent(root, 'a1', [textLine('2026-01-01T00:00:00Z')]);
    writeMeta(root, 'a1', {
      agentType: 'general-purpose',
      isBuiltIn: true,
      description: 'Shared: transcript, parser',
      toolUseId: 'toolu_017x',
      spawnDepth: 2,
      parentAgentId: 'a0',
      requestShape: 'background',
      requestNonInteractive: true,
      finished: true,
      stoppedByUser: false,
    });
    expect(readAgentMeta(path.join(root, 'session', 'subagents', 'agent-a1.jsonl'))).toEqual({
      agentType: 'general-purpose',
      description: 'Shared: transcript, parser',
      toolUseId: 'toolu_017x',
      parentAgentId: 'a0',
      requestShape: 'background',
      finished: true,
      stoppedByUser: false,
    });
  });

  it('drops wrongly typed fields and tolerates missing or malformed files', () => {
    const root = tempRoot();
    writeMeta(root, 'bad', {
      agentType: 7,
      description: '',
      toolUseId: ['x'],
      parentAgentId: null,
      requestShape: true,
      finished: 'yes',
      stoppedByUser: 1,
    });
    const dir = path.join(root, 'session', 'subagents');
    expect(readAgentMeta(path.join(dir, 'agent-bad.jsonl'))).toEqual({});
    expect(readAgentMeta(path.join(dir, 'agent-missing.jsonl'))).toEqual({});
    fs.writeFileSync(path.join(dir, 'agent-broken.meta.json'), '{not json');
    expect(readAgentMeta(path.join(dir, 'agent-broken.jsonl'))).toEqual({});
    fs.writeFileSync(path.join(dir, 'agent-array.meta.json'), '[1]');
    expect(readAgentMeta(path.join(dir, 'agent-array.jsonl'))).toEqual({});
  });
});

describe('scanSubagentTraces spawn metadata', () => {
  it('exposes meta fields and nests children by parentAgentId', () => {
    const root = tempRoot();
    writeAgent(root, 'parent', [
      textLine('2026-01-01T00:00:00.000Z'),
      spawnLine('2026-01-01T00:00:05.000Z', 'toolu_child'),
    ]);
    writeMeta(root, 'parent', {
      agentType: 'Explore',
      toolUseId: 'toolu_parent',
      requestShape: 'background',
      finished: true,
    });
    writeAgent(root, 'child', [textLine('2026-01-01T00:00:06.000Z')]);
    writeMeta(root, 'child', {
      agentType: 'general-purpose',
      toolUseId: 'toolu_child',
      parentAgentId: 'parent',
      requestShape: 'foreground',
    });

    const traces = scanSubagentTraces(root, 'session');
    expect(traces.map((trace) => trace.agentId)).toEqual(['parent']);
    const [parent] = traces;
    expect(parent).toMatchObject({
      filePath: path.join(root, 'session', 'subagents', 'agent-parent.jsonl'),
      spawnToolUseId: 'toolu_parent',
      parentToolUseId: 'toolu_parent',
      background: true,
      finished: true,
    });
    expect(parent.parentAgentId).toBeUndefined();
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toMatchObject({
      agentId: 'child',
      spawnToolUseId: 'toolu_child',
      parentToolUseId: 'toolu_child',
      parentAgentId: 'parent',
      background: false,
    });
    expect(parent.children[0].finished).toBeUndefined();
  });

  it("links by the child's spawn tool_use id found in another trace", () => {
    const root = tempRoot();
    writeAgent(root, 'parent', [spawnLine('2026-01-01T00:00:00.000Z', 'toolu_child', 'Task')]);
    writeMeta(root, 'parent', { toolUseId: 'toolu_parent' });
    writeAgent(root, 'child', [textLine('2026-01-01T00:01:00.000Z')]);
    writeMeta(root, 'child', { toolUseId: 'toolu_child' });

    const [parent, ...rest] = scanSubagentTraces(root, 'session');
    expect(rest).toEqual([]);
    expect(parent.children.map((child) => child.agentId)).toEqual(['child']);
    expect(parent.children[0].parentAgentId).toBe('parent');
  });

  it('keeps traces spawned from the main session top-level, without heuristics', () => {
    const root = tempRoot();
    // Sibling started 1 s after the other agent's own spawn call: the old
    // positional heuristic would have nested it.
    writeAgent(root, 'first', [spawnLine('2026-01-01T00:00:00.000Z', 'toolu_nested')]);
    writeMeta(root, 'first', { toolUseId: 'toolu_first' });
    writeAgent(root, 'sibling', [textLine('2026-01-01T00:00:01.000Z')]);
    writeMeta(root, 'sibling', { toolUseId: 'toolu_sibling' });

    const traces = scanSubagentTraces(root, 'session');
    expect(traces.map((trace) => trace.agentId).sort()).toEqual(['first', 'sibling']);
    expect(traces.every((trace) => trace.children.length === 0)).toBe(true);
  });

  it('keeps orphans and survives a parentAgentId cycle', () => {
    const root = tempRoot();
    writeAgent(root, 'orphan', [textLine('2026-01-01T00:00:00.000Z')]);
    writeMeta(root, 'orphan', { toolUseId: 'toolu_o', parentAgentId: 'gone' });
    writeAgent(root, 'a', [textLine('2026-01-01T00:00:00.000Z')]);
    writeMeta(root, 'a', { toolUseId: 'toolu_a', parentAgentId: 'b' });
    writeAgent(root, 'b', [textLine('2026-01-01T00:00:00.000Z')]);
    writeMeta(root, 'b', { toolUseId: 'toolu_b', parentAgentId: 'a' });

    const traces = scanSubagentTraces(root, 'session');
    expect(
      flatten(traces)
        .map((trace) => trace.agentId)
        .sort(),
    ).toEqual(['a', 'b', 'orphan']);
    expect(traces.map((trace) => trace.agentId)).toContain('orphan');
    expect(traces).toHaveLength(2);
  });
});
