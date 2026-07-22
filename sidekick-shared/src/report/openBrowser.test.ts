import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { openInBrowser } from './openBrowser';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('openInBrowser', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => setPlatform(originalPlatform));

  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ] as const)('passes hostile paths as one argument on %s', (platform, executable) => {
    setPlatform(platform);
    const filePath = '/tmp/report"; touch /tmp/pwned; #.html';

    openInBrowser(filePath);

    expect(mockExecFile).toHaveBeenCalledWith(executable, [`file://${filePath}`]);
  });

  it('uses argument-array spawning on Windows', () => {
    setPlatform('win32');
    const filePath = 'C:\\reports\\report & calc.exe.html';

    openInBrowser(filePath);

    expect(mockExecFile).toHaveBeenCalledWith('rundll32.exe', [
      'url.dll,FileProtocolHandler',
      `file://${filePath}`,
    ]);
  });
});
