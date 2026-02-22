import { describe, it, expect } from 'vitest';
import { encodeWorkspacePath, getConfigDir } from './paths';

describe('encodeWorkspacePath', () => {
  it('replaces forward slashes with hyphens', () => {
    expect(encodeWorkspacePath('/home/user/project')).toBe('-home-user-project');
  });

  it('replaces colons with hyphens', () => {
    expect(encodeWorkspacePath('C:/Users/project')).toBe('C--Users-project');
  });

  it('replaces underscores with hyphens', () => {
    expect(encodeWorkspacePath('/home/my_project')).toBe('-home-my-project');
  });

  it('normalizes backslashes to forward slashes first', () => {
    expect(encodeWorkspacePath('C:\\Users\\project')).toBe('C--Users-project');
  });

  it('handles complex paths', () => {
    expect(encodeWorkspacePath('/home/user/my_code/project_v2')).toBe('-home-user-my-code-project-v2');
  });
});

describe('getConfigDir', () => {
  it('returns a string path', () => {
    const dir = getConfigDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });

  it('ends with sidekick', () => {
    const dir = getConfigDir();
    expect(dir).toMatch(/sidekick$/);
  });
});
