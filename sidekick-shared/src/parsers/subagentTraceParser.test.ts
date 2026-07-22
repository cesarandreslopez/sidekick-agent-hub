import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanSubagentDir } from './subagentScanner';
import { scanSubagentTraces } from './subagentTraceParser';

const roots: string[] = [];

function writeAgent(root: string, id: string, lines: unknown[]): void {
  const dir = path.join(root, 'session', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map(JSON.stringify).join('\n'));
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
});
