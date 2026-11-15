import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: '/ws' } }] },
}));
vi.mock('../services/Logger', () => ({ log: vi.fn() }));
vi.mock('../services/SubagentFileScanner', () => ({ scanSubagentDir: vi.fn() }));

import { TempFilesTreeProvider } from './TempFilesTreeProvider';

const provider = Object.create(TempFilesTreeProvider.prototype) as unknown as {
  extractFilePathsFromBash(command: string): string[];
  resolvePath(filePath: string): string;
};

describe('TempFilesTreeProvider Bash paths', () => {
  it('lists files a command writes', () => {
    expect(provider.extractFilePathsFromBash('echo hi > out.txt')).toEqual(['out.txt']);
    expect(provider.extractFilePathsFromBash('touch a.ts b.ts')).toEqual(['a.ts', 'b.ts']);
  });

  it('skips rm and mkdir, which leave nothing to open', () => {
    expect(provider.extractFilePathsFromBash('rm -rf dist')).toEqual([]);
    expect(provider.extractFilePathsFromBash('mkdir -p build/tmp')).toEqual([]);
  });

  it('does not read arrows in inline code as redirections', () => {
    expect(provider.extractFilePathsFromBash('node -e "[1].map(x => x)"')).toEqual([]);
    expect(provider.extractFilePathsFromBash("php -r '$a->b;'")).toEqual([]);
  });

  it('resolves relative paths against the workspace folder', () => {
    expect(provider.resolvePath('dist/out.txt')).toBe('/ws/dist/out.txt');
    expect(provider.resolvePath('/tmp/a.txt')).toBe('/tmp/a.txt');
  });
});
