import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getClaudeProjectsDir,
  getDefaultClaudeHome,
  getLiveClaudeHome,
  isDefaultClaudeHome,
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
