import { describe, it, expect } from 'vitest';
import { generateHtmlReport } from './htmlReportGenerator';
import { escapeHtml, simpleMarkdownToHtml, highlightCodeBlock } from './htmlHelpers';
import type { AggregatedMetrics } from '../aggregation/types';
import type { TranscriptEntry } from './types';

function makeMetrics(overrides: Partial<AggregatedMetrics> = {}): AggregatedMetrics {
  return {
    sessionStartTime: '2025-01-15T10:00:00Z',
    lastEventTime: '2025-01-15T10:30:00Z',
    messageCount: 5,
    eventCount: 12,
    currentModel: 'claude-sonnet-4-20250514',
    providerId: 'claude-code',
    tokens: {
      inputTokens: 10000,
      outputTokens: 5000,
      cacheWriteTokens: 2000,
      cacheReadTokens: 8000,
      reportedCost: 0.15,
    },
    modelStats: [
      { model: 'claude-sonnet-4-20250514', calls: 5, tokens: 15000, inputTokens: 10000, outputTokens: 5000, cacheWriteTokens: 2000, cacheReadTokens: 8000, cost: 0.15 },
    ],
    currentContextSize: 50000,
    contextAttribution: { systemPrompt: 0, userMessages: 0, assistantResponses: 0, toolInputs: 0, toolOutputs: 0, thinking: 0, other: 0 },
    compactionCount: 0,
    compactionEvents: [],
    truncationCount: 0,
    truncationEvents: [],
    toolStats: [
      { name: 'Read', successCount: 3, failureCount: 0, completedCount: 3, totalDuration: 600, pendingCount: 0 },
      { name: 'Edit', successCount: 2, failureCount: 1, completedCount: 2, totalDuration: 400, pendingCount: 0 },
    ],
    burnRate: { tokensPerMinute: 500, points: [], sampleCount: 0 },
    taskState: { tasks: new Map(), activeTaskId: null },
    subagents: [],
    plan: null,
    permissionMode: null,
    permissionModeHistory: [],
    contextTimeline: [],
    timeline: [],
    latencyStats: null,
    ...overrides,
  };
}

describe('generateHtmlReport', () => {
  const transcript: TranscriptEntry[] = [
    {
      type: 'user',
      timestamp: '2025-01-15T10:00:00Z',
      content: [{ type: 'text', text: 'Help me fix this bug' }],
    },
    {
      type: 'assistant',
      timestamp: '2025-01-15T10:00:01Z',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 500, output_tokens: 200 },
      content: [
        { type: 'thinking', text: 'Let me analyze...' },
        { type: 'text', text: 'I found the issue.' },
        { type: 'tool_use', toolName: 'Read', toolUseId: 'toolu_1', toolInput: { file_path: '/src/main.ts' } },
      ],
    },
    {
      type: 'user',
      timestamp: '2025-01-15T10:00:02Z',
      content: [{ type: 'tool_result', toolUseId: 'toolu_1', output: 'const x = 1;', isError: false }],
    },
  ];

  it('generates valid HTML document', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<title>Sidekick Session Report</title>');
  });

  it('includes session file name in title when provided', () => {
    const html = generateHtmlReport(makeMetrics(), transcript, { sessionFileName: 'abc123.jsonl' });
    expect(html).toContain('abc123.jsonl');
  });

  it('includes stats cards with token data', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('Total Tokens');
    expect(html).toContain('15.0k'); // 10000 + 5000
    expect(html).toContain('$0.15');
  });

  it('renders model breakdown table', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('Model Breakdown');
    expect(html).toContain('claude-sonnet-4-20250514');
  });

  it('renders tool breakdown table', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('Tool Breakdown');
    expect(html).toContain('Read');
    expect(html).toContain('Edit');
  });

  it('renders transcript messages with role badges', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('class="role-badge user"');
    expect(html).toContain('class="role-badge assistant"');
    expect(html).toContain('Help me fix this bug');
    expect(html).toContain('I found the issue.');
  });

  it('includes thinking blocks by default', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('Thinking...');
    expect(html).toContain('Let me analyze...');
  });

  it('excludes thinking blocks when includeThinking is false', () => {
    const html = generateHtmlReport(makeMetrics(), transcript, { includeThinking: false });
    expect(html).not.toContain('Thinking...');
    expect(html).not.toContain('Let me analyze...');
  });

  it('includes tool details by default', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('file_path');
    expect(html).toContain('/src/main.ts');
  });

  it('renders tool results', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('const x = 1;');
  });

  it('includes inline CSS', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('<style>');
    expect(html).toContain('--accent-purple');
  });

  it('includes inline JavaScript', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('<script>');
    expect(html).toContain('filterMessages');
    expect(html).toContain('toggleAllDetails');
    expect(html).toContain('copyCode');
  });

  it('includes filter controls', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('filter-user');
    expect(html).toContain('filter-assistant');
    expect(html).toContain('filter-tool');
    expect(html).toContain('filter-thinking');
    expect(html).toContain('Expand All');
    expect(html).toContain('Collapse All');
  });

  it('handles empty transcript', () => {
    const html = generateHtmlReport(makeMetrics(), []);
    expect(html).toContain('No transcript data available');
  });

  it('handles no model stats', () => {
    const html = generateHtmlReport(makeMetrics({ modelStats: [] }), transcript);
    expect(html).not.toContain('Model Breakdown');
  });

  it('handles no tool stats', () => {
    const html = generateHtmlReport(makeMetrics({ toolStats: [] }), transcript);
    expect(html).not.toContain('Tool Breakdown');
  });

  it('renders back to top button', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('backToTop');
  });

  it('sets dark theme by default', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).toContain('data-theme="dark"');
  });

  it('sets light theme when specified', () => {
    const html = generateHtmlReport(makeMetrics(), transcript, { theme: 'light' });
    expect(html).toContain('data-theme="light"');
  });
});

describe('escapeHtml', () => {
  it('escapes all special HTML characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('simpleMarkdownToHtml', () => {
  it('renders headings', () => {
    const result = simpleMarkdownToHtml('# Title');
    expect(result).toContain('<h1>Title</h1>');
  });

  it('renders bold text', () => {
    const result = simpleMarkdownToHtml('This is **bold** text');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    const result = simpleMarkdownToHtml('This is *italic* text');
    expect(result).toContain('<em>italic</em>');
  });

  it('renders inline code', () => {
    const result = simpleMarkdownToHtml('Use `console.log` here');
    expect(result).toContain('<code class="inline-code">console.log</code>');
  });

  it('renders fenced code blocks', () => {
    const result = simpleMarkdownToHtml('```js\nconst x = 1;\n```');
    expect(result).toContain('code-block');
    expect(result).toContain('copy-btn');
  });

  it('renders links', () => {
    const result = simpleMarkdownToHtml('[click here](https://example.com)');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('click here');
  });
});

describe('highlightCodeBlock', () => {
  it('highlights JSON keys and values', () => {
    const result = highlightCodeBlock('{"key": "value"}', 'json');
    expect(result).toContain('hl-key');
    expect(result).toContain('hl-string');
  });

  it('highlights JS keywords', () => {
    const result = highlightCodeBlock('const x = 1;', 'js');
    expect(result).toContain('hl-keyword');
  });

  it('returns escaped text for unknown languages', () => {
    const result = highlightCodeBlock('<div>test</div>', 'xml');
    expect(result).toContain('&lt;div&gt;');
    expect(result).not.toContain('hl-keyword');
  });
});
