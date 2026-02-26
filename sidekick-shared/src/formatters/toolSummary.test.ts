import { describe, it, expect } from 'vitest';
import { formatToolSummary } from './toolSummary';

describe('formatToolSummary', () => {
  describe('Read', () => {
    it('shows basename for simple file path', () => {
      expect(formatToolSummary('Read', { file_path: '/home/user/project/main.go' }))
        .toBe('main.go');
    });

    it('shows line range when offset and limit provided', () => {
      expect(formatToolSummary('Read', { file_path: '/src/main.go', offset: 10, limit: 40 }))
        .toBe('main.go:10-50');
    });

    it('shows offset with + when only offset provided', () => {
      expect(formatToolSummary('Read', { file_path: '/src/main.go', offset: 10 }))
        .toBe('main.go:10+');
    });

    it('shows line count when only limit provided', () => {
      expect(formatToolSummary('Read', { file_path: '/src/main.go', limit: 50 }))
        .toBe('main.go (50 lines)');
    });
  });

  describe('Write', () => {
    it('shows basename and line count', () => {
      expect(formatToolSummary('Write', { file_path: '/config.json', content: 'a\nb\nc\n' }))
        .toBe('config.json — 4 lines');
    });

    it('shows just basename when no content', () => {
      expect(formatToolSummary('Write', { file_path: '/config.json' }))
        .toBe('config.json');
    });
  });

  describe('Edit', () => {
    it('shows basename and line change', () => {
      expect(formatToolSummary('Edit', {
        file_path: '/src/main.go',
        old_string: 'line1\nline2',
        new_string: 'new1\nnew2\nnew3',
      })).toBe('main.go — 2→3 lines');
    });
  });

  describe('Bash', () => {
    it('prefers description field', () => {
      expect(formatToolSummary('Bash', {
        command: 'npm run test',
        description: 'Run tests',
      })).toBe('Run tests');
    });

    it('falls back to first line of command', () => {
      expect(formatToolSummary('Bash', { command: 'npm install && npm run build' }))
        .toBe('npm install && npm run build');
    });

    it('takes first line of multi-line command', () => {
      expect(formatToolSummary('Bash', { command: 'cd /tmp\nls -la\npwd' }))
        .toBe('cd /tmp');
    });
  });

  describe('Grep', () => {
    it('shows pattern and glob', () => {
      expect(formatToolSummary('Grep', { pattern: 'TODO', glob: '*.ts' }))
        .toBe('TODO in *.ts');
    });

    it('shows pattern and type', () => {
      expect(formatToolSummary('Grep', { pattern: 'import', type: 'ts' }))
        .toBe('import in *.ts');
    });

    it('shows pattern and path basename', () => {
      expect(formatToolSummary('Grep', { pattern: 'error', path: '/src/services' }))
        .toBe('error in services');
    });

    it('shows just pattern when no filters', () => {
      expect(formatToolSummary('Grep', { pattern: 'hello world' }))
        .toBe('hello world');
    });
  });

  describe('Glob', () => {
    it('shows pattern', () => {
      expect(formatToolSummary('Glob', { pattern: '**/*.test.ts' }))
        .toBe('**/*.test.ts');
    });

    it('shows pattern with path', () => {
      expect(formatToolSummary('Glob', { pattern: '*.ts', path: '/src' }))
        .toBe('*.ts in src');
    });
  });

  describe('Task', () => {
    it('shows subagent type and description', () => {
      expect(formatToolSummary('Task', {
        subagent_type: 'Explore',
        description: 'search for auth patterns',
        prompt: 'Find all authentication-related code...',
      })).toBe('[Explore] search for auth patterns');
    });

    it('falls back to prompt when no description', () => {
      expect(formatToolSummary('Task', {
        subagent_type: 'Plan',
        prompt: 'Plan the refactoring of the auth module',
      })).toBe('[Plan] Plan the refactoring of the auth module');
    });
  });

  describe('WebFetch', () => {
    it('shows hostname and path', () => {
      expect(formatToolSummary('WebFetch', { url: 'https://docs.example.com/api/v2/reference' }))
        .toBe('docs.example.com/api/v2/reference');
    });

    it('handles invalid URLs gracefully', () => {
      expect(formatToolSummary('WebFetch', { url: 'not-a-url' }))
        .toBe('not-a-url');
    });
  });

  describe('WebSearch', () => {
    it('shows query', () => {
      expect(formatToolSummary('WebSearch', { query: 'typescript generics tutorial' }))
        .toBe('typescript generics tutorial');
    });
  });

  describe('TaskCreate', () => {
    it('shows subject', () => {
      expect(formatToolSummary('TaskCreate', { subject: 'Fix authentication bug' }))
        .toBe('Fix authentication bug');
    });
  });

  describe('TaskUpdate', () => {
    it('shows task id and status', () => {
      expect(formatToolSummary('TaskUpdate', { task_id: 'task-1', status: 'completed' }))
        .toBe('task-1 → completed');
    });
  });

  describe('MCP tools', () => {
    it('strips MCP prefix and matches base tool name', () => {
      expect(formatToolSummary('mcp__server__Read', { file_path: '/foo/bar.ts' }))
        .toBe('bar.ts');
    });
  });

  describe('unknown tools', () => {
    it('falls back to generic field extraction', () => {
      expect(formatToolSummary('CustomTool', { command: 'do-thing' }))
        .toBe('do-thing');
    });

    it('falls back to first string value', () => {
      expect(formatToolSummary('CustomTool', { data: 'some value' }))
        .toBe('some value');
    });

    it('returns empty string when no extractable fields', () => {
      expect(formatToolSummary('CustomTool', { count: 42 }))
        .toBe('');
    });
  });

  describe('truncation', () => {
    it('truncates long summaries', () => {
      const longCommand = 'x'.repeat(200);
      const result = formatToolSummary('Bash', { command: longCommand });
      expect(result.length).toBeLessThanOrEqual(80);
      expect(result).toMatch(/\.\.\.$/);
    });
  });
});
