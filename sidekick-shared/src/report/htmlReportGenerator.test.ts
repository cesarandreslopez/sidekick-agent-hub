import { describe, it, expect } from 'vitest';
import { generateHtmlReport } from './htmlReportGenerator';
import { parseTranscriptFromEvents } from './transcriptParser';
import { escapeHtml, simpleMarkdownToHtml, highlightCodeBlock } from './htmlHelpers';
import type { AggregatedMetrics } from '../aggregation/types';
import type { TranscriptEntry } from './types';
import { busyInsights, busySnapshot, hostileSnapshot } from '../testing/activityFixtures.setup';

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
      {
        model: 'claude-sonnet-4-20250514',
        calls: 5,
        tokens: 15000,
        inputTokens: 10000,
        outputTokens: 5000,
        cacheWriteTokens: 2000,
        cacheReadTokens: 8000,
        cost: 0.15,
      },
    ],
    currentContextSize: 50000,
    contextAttribution: {
      systemPrompt: 0,
      userMessages: 0,
      assistantResponses: 0,
      toolInputs: 0,
      toolOutputs: 0,
      thinking: 0,
      other: 0,
    },
    compactionCount: 0,
    compactionEvents: [],
    truncationCount: 0,
    truncationEvents: [],
    toolStats: [
      {
        name: 'Read',
        successCount: 3,
        failureCount: 0,
        completedCount: 3,
        totalDuration: 600,
        pendingCount: 0,
      },
      {
        name: 'Edit',
        successCount: 2,
        failureCount: 1,
        completedCount: 2,
        totalDuration: 400,
        pendingCount: 0,
      },
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
        {
          type: 'tool_use',
          toolName: 'Read',
          toolUseId: 'toolu_1',
          toolInput: { file_path: '/src/main.ts' },
        },
      ],
    },
    {
      type: 'user',
      timestamp: '2025-01-15T10:00:02Z',
      content: [
        { type: 'tool_result', toolUseId: 'toolu_1', output: 'const x = 1;', isError: false },
      ],
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
    expect(html).toContain('Total (incl. cache)');
    expect(html).not.toContain('Total Tokens');
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

  it('hides parser bookkeeping keys and names the raw tool and MCP server', () => {
    const projected = parseTranscriptFromEvents([
      {
        type: 'assistant',
        timestamp: '2025-01-15T10:00:01Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'Search',
              input: {
                query: 'retry policy',
                _sidekickRawToolName: 'search',
                _sidekickMcpServerName: 'docs',
              },
            },
          ],
        },
      },
    ]);
    // Entries assembled by hand may still carry the keys inside toolInput.
    const handBuilt: TranscriptEntry[] = [
      {
        type: 'assistant',
        timestamp: '2025-01-15T10:00:02Z',
        content: [
          {
            type: 'tool_use',
            toolName: 'Bash',
            toolUseId: 'call-2',
            toolInput: { command: 'ls', _sidekickRawToolName: 'exec_command' },
          },
        ],
      },
    ];

    for (const includeToolDetail of [true, false]) {
      const html = generateHtmlReport(makeMetrics(), [...projected, ...handBuilt], {
        includeToolDetail,
      });
      expect(html).not.toContain('_sidekick');
      expect(html).toContain('search · MCP: docs');
      expect(html).toContain('exec_command');
    }
    const detailed = generateHtmlReport(makeMetrics(), [...projected, ...handBuilt]);
    expect(detailed).toContain('retry policy');
    expect(handBuilt[0].content[0].toolInput).toHaveProperty('_sidekickRawToolName');
  });

  it('adds no raw-name hint when the raw name matches the tool name', () => {
    const html = generateHtmlReport(makeMetrics(), transcript);
    expect(html).not.toContain('tool-raw-name');
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
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
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

  it('renders unsafe javascript and data links as inert text', () => {
    const result = simpleMarkdownToHtml(
      '[script](javascript:alert(1)) [payload](data:text/html;base64,PHNjcmlwdD4=)',
    );

    expect(result).not.toContain('<a href="javascript:');
    expect(result).not.toContain('<a href="data:');
    expect(result).toContain('[script](javascript:alert(1))');
    expect(result).toContain('[payload](data:text/html;base64,PHNjcmlwdD4=)');
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

describe('generateHtmlReport activity section', () => {
  const activity = { snapshot: busySnapshot(), insights: busyInsights() };
  const section = (html: string): string => {
    const start = html.indexOf('<div class="section" id="activity-map">');
    const end = html.indexOf(
      '<div class="section">\n<div class="section-title">Conversation Transcript',
    );
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, end);
  };

  it('is left out without activity', () => {
    const html = generateHtmlReport(makeMetrics(), []);
    expect(html).not.toContain('id="activity-map"');
    expect(html).not.toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 460"');
  });

  it('shows a still map, the stations by busy time, the patterns and a summary', () => {
    const html = generateHtmlReport(makeMetrics(), [], { activity });
    const part = section(html);
    expect(part).toContain('<div class="section-title">Activity Map</div>');
    expect(part).toContain('<figure class="activity-figure"><svg');
    expect(part).not.toMatch(/<animate/);
    expect(part).toContain('<figcaption>93 calls at 10 stations over 6m32s');
    const order = [...part.matchAll(/<\/svg>([A-Z][a-z]+)<\/td>/g)].map((m) => m[1]);
    expect(order.slice(0, 3)).toEqual(['Shell', 'Files', 'Network']);
    expect(part).toContain('<span class="activity-bad">3</span>');
    expect(part).toContain('<li>Shell failed 3× in a row</li>');
    expect(part).toContain('<li>edit ↔ test loop ×4</li>');
    expect(part).toContain('<code>npm test</code> ×12');
    // The section comes right after the tool breakdown.
    expect(html.indexOf('Tool Breakdown')).toBeLessThan(html.indexOf('id="activity-map"'));
  });

  it('is CSP-safe: no inline styles, handlers or scripts, presentation colors only', () => {
    const part = section(generateHtmlReport(makeMetrics(), [], { activity }));
    expect(part).not.toMatch(/\sstyle=/);
    expect(part).not.toMatch(/\son[a-z]+=/i);
    expect(part).not.toMatch(/<script/);
    expect(part).not.toMatch(/<style(?!>)/);
    expect(part).not.toMatch(/<style>/);
  });

  it('matches the map to the report theme and colors the light theme', () => {
    const dark = generateHtmlReport(makeMetrics(), [], { activity });
    expect(section(dark)).toContain('data-theme="dark"');
    const light = generateHtmlReport(makeMetrics(), [], { activity, theme: 'light' });
    expect(section(light)).toContain('data-theme="light"');
    expect(section(light)).toContain('fill="#f8f6fc"');
    expect(light).toContain('[data-theme="light"] {');
    expect(light).toContain('--bg-primary: #f7f5fb;');
  });

  it('escapes hostile labels', () => {
    const part = section(
      generateHtmlReport(makeMetrics(), [], {
        activity: {
          snapshot: hostileSnapshot(),
          insights: {
            ...busyInsights(),
            stations: busyInsights().stations.map((s) => ({
              ...s,
              topLabels: s.topLabels.map((l) => ({ ...l, label: '<img src=x onerror=alert(1)>' })),
            })),
          },
          coreName: '<b>x</b>',
        },
      }),
    );
    expect(part).not.toContain('<img');
    expect(part).not.toContain('<b>x');
    expect(part).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
