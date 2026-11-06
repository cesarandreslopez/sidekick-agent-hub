import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getClaudeProjectsDir,
  getClaudeSubagentTranscriptPath,
  getClaudeSubagentsDir,
  getDefaultClaudeHome,
  getLiveClaudeHome,
  isClaudeAgentId,
  isDefaultClaudeHome,
  parseClaudeSubagentFileName,
} from './claudePaths';

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe('claudePaths', () => {
  it('uses ~/.claude when CLAUDE_CONFIG_DIR is unset or blank', () => {
    process.env.CLAUDE_CONFIG_DIR = '  ';
    expect(isDefaultClaudeHome()).toBe(true);
    expect(getLiveClaudeHome()).toBe(path.join(os.homedir(), '.claude'));
    expect(getClaudeProjectsDir()).toBe(path.join(getDefaultClaudeHome(), 'projects'));
  });

  it('follows CLAUDE_CONFIG_DIR like the claude CLI', () => {
    process.env.CLAUDE_CONFIG_DIR = ' /tmp/custom-claude ';
    expect(isDefaultClaudeHome()).toBe(false);
    expect(getLiveClaudeHome()).toBe('/tmp/custom-claude');
    expect(getClaudeProjectsDir()).toBe(path.join('/tmp/custom-claude', 'projects'));
  });
});

describe('Claude subagent transcript paths', () => {
  const session = path.join('/home/u/.claude/projects/-work-app', 'abc-123.jsonl');

  it('places subagent transcripts under <session id>/subagents beside the session', () => {
    expect(getClaudeSubagentsDir(session)).toBe(
      path.join('/home/u/.claude/projects/-work-app', 'abc-123', 'subagents'),
    );
    expect(getClaudeSubagentTranscriptPath(session, 'a1b2c3d4e5f6a7b8c')).toBe(
      path.join(getClaudeSubagentsDir(session), 'agent-a1b2c3d4e5f6a7b8c.jsonl'),
    );
  });

  it('refuses ids that could leave the subagents directory', () => {
    for (const bad of ['', '../x', 'a/b', '-lead', 'a b', '.hidden']) {
      expect(isClaudeAgentId(bad)).toBe(false);
      expect(getClaudeSubagentTranscriptPath(session, bad)).toBeNull();
    }
    expect(isClaudeAgentId('acompact-3f2a_x')).toBe(true);
  });

  it('parses transcript names and nothing else', () => {
    expect(parseClaudeSubagentFileName('agent-a1b2.jsonl')).toBe('a1b2');
    expect(parseClaudeSubagentFileName('agent-a1b2.meta.json')).toBeNull();
    expect(parseClaudeSubagentFileName('agent-.jsonl')).toBeNull();
    expect(parseClaudeSubagentFileName('notes.jsonl')).toBeNull();
    expect(parseClaudeSubagentFileName('agent-a.b.jsonl')).toBeNull();
  });
});
