import { describe, expect, it } from 'vitest';
import { clipboardAttempts } from './clipboard';

describe('clipboardAttempts', () => {
  it('uses the native clip.exe stdin command on Windows', () => {
    expect(clipboardAttempts('win32', false, false)).toEqual([['clip.exe', []]]);
  });

  it('retains WSL and Unix clipboard fallbacks', () => {
    expect(clipboardAttempts('linux', true, false)[0]).toEqual(['clip.exe', []]);
    expect(clipboardAttempts('linux', false, true)).toContainEqual(['wl-copy', []]);
  });
});
