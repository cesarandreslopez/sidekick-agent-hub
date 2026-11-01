import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ default: {} }));
vi.mock('../services/Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { ToolInspectorProvider } from './ToolInspectorProvider';
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
});
