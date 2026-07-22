import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockPlatform = vi.hoisted(() => vi.fn<() => NodeJS.Platform>());

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));
vi.mock('node:os', () => ({ platform: () => mockPlatform() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => '') }));

import { openUrl } from './openUrl';

describe('openUrl', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockPlatform.mockReturnValue('linux');
  });

  it('uses the Windows URL handler with literal arguments', () => {
    mockPlatform.mockReturnValue('win32');
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mockSpawn.mockReturnValue(child);

    expect(openUrl('https://example.com/?x=1&y=2')).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', 'https://example.com/?x=1&y=2'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('absorbs asynchronous spawn errors instead of crashing', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mockSpawn.mockReturnValue(child);

    expect(openUrl('https://example.com')).toBe(true);
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
  });
});
