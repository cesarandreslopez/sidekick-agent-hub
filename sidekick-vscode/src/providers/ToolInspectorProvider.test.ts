import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ default: {} }));
vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { ToolInspectorProvider, truncateHeadTail } from './ToolInspectorProvider';
import type { ToolCall } from '../types/claudeSession';

function render(call: ToolCall): string {
  const provider = new ToolInspectorProvider({} as never, {} as never);
  return (
    provider as unknown as { renderToolCall(call: ToolCall, index: number): string }
  ).renderToolCall(call, 0);
}

describe('ToolInspectorProvider', () => {
  it('shows the raw tool name and MCP server, and hides _sidekick keys from the input', () => {
    const html = render({
      name: 'mcp__github__search_issues',
      providerId: 'codex',
      timestamp: new Date('2026-11-01T00:00:00Z'),
      input: {
        query: 'is:open',
        _sidekickRawToolName: 'search_issues',
        _sidekickMcpServerName: 'github',
      },
    });
    expect(html).toContain('raw: search_issues');
    expect(html).toContain('mcp: github');
    expect(html).toContain('&quot;query&quot;: &quot;is:open&quot;');
    expect(html).not.toContain('_sidekick');
  });

  it('prefers the recorded raw name and omits badges that add nothing', () => {
    const html = render({
      name: 'Bash',
      rawName: 'Bash',
      timestamp: new Date('2026-11-01T00:00:00Z'),
      input: { command: 'ls' },
    });
    expect(html).not.toContain('raw:');
    expect(html).not.toContain('mcp:');
  });

  it('formats durations instead of printing raw milliseconds', () => {
    const html = render({
      name: 'Bash',
      timestamp: new Date('2026-11-01T00:00:00Z'),
      duration: 125_000,
      input: { command: 'npm test' },
    });
    expect(html).toContain('2m 5s');
    expect(html).not.toContain('125000ms');
  });

  it('says when an edit carries no recorded patch content', () => {
    const html = render({
      name: 'Edit',
      timestamp: new Date('2026-11-01T00:00:00Z'),
      input: { file_path: 'src/a.ts' },
    });
    expect(html).toContain('Patch content not recorded');
  });

  it('renders every MultiEdit pair', () => {
    const html = render({
      name: 'MultiEdit',
      timestamp: new Date('2026-11-01T00:00:00Z'),
      input: {
        file_path: 'src/a.ts',
        edits: [
          { old_string: 'one', new_string: 'uno' },
          { old_string: 'two', new_string: 'dos' },
        ],
      },
    });
    expect(html).toContain('- one');
    expect(html).toContain('+ dos');
  });

  it('header is a keyboard-operable button', () => {
    const html = render({
      name: 'Read',
      timestamp: new Date('2026-11-01T00:00:00Z'),
      input: { file_path: 'a.ts' },
    });
    expect(html).toContain('<button type="button" class="tool-call-header"');
  });
});

describe('truncateHeadTail', () => {
  it('keeps short text intact', () => {
    expect(truncateHeadTail('abc', 2, 2)).toBe('abc');
  });

  it('keeps the head and the tail of long output', () => {
    const out = truncateHeadTail('HEAD' + 'x'.repeat(100) + 'TAIL', 4, 4);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('100 characters omitted');
  });
});
