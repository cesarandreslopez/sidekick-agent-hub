import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractUrls, extractFilePaths, extractCommands } from './sessionAssets';

describe('extractUrls', () => {
  it('extracts http/https/file URLs', () => {
    const text = 'see https://example.com and http://foo.test/bar and file:///etc/hosts';
    expect(extractUrls(text)).toEqual([
      'https://example.com',
      'http://foo.test/bar',
      'file:///etc/hosts',
    ]);
  });

  it('strips trailing punctuation', () => {
    expect(extractUrls('Go to https://example.com/path.')).toEqual(['https://example.com/path']);
    expect(extractUrls('(https://example.com),')).toEqual(['https://example.com']);
  });

  it('returns [] for empty/nullish input', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls(undefined)).toEqual([]);
    expect(extractUrls(null)).toEqual([]);
  });
});

describe('extractCommands', () => {
  it('extracts lines from shell-tagged fenced blocks', () => {
    const text = '```bash\nnpm run build\nnpm test\n```';
    expect(extractCommands(text)).toEqual(['npm run build', 'npm test']);
  });

  it('skips comments and joins line continuations in shell blocks', () => {
    const text = '```sh\n# build it\ndocker run \\\n  --rm hello\n```';
    expect(extractCommands(text)).toEqual(['docker run --rm hello']);
  });

  it('ignores non-$ lines in untagged blocks but keeps $-prefixed ones', () => {
    const text = '```\nthis is prose\n$ echo hi\n```';
    expect(extractCommands(text)).toEqual(['echo hi']);
  });

  it('extracts $-prefixed lines from prose outside blocks', () => {
    const text = 'Run this:\n$ git status\nthen review.';
    expect(extractCommands(text)).toEqual(['git status']);
  });

  it('does not double-count $ lines already inside a block', () => {
    const text = '```bash\n$ ls -la\n```';
    expect(extractCommands(text)).toEqual(['ls -la']);
  });
});

describe('extractFilePaths', () => {
  let dir: string;
  let realFile: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-assets-'));
    realFile = path.join(dir, 'real.ts');
    fs.writeFileSync(realFile, '// hi');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns only paths that exist on disk', () => {
    const text = `edit ${realFile} and ${path.join(dir, 'nope.ts')}`;
    expect(extractFilePaths(text, dir)).toEqual([{ file: realFile }]);
  });

  it('parses :line suffixes', () => {
    const text = `error at ${realFile}:42:7`;
    expect(extractFilePaths(text, dir)).toEqual([{ file: realFile, line: 42 }]);
  });

  it('resolves relative paths against cwd', () => {
    expect(extractFilePaths('see real.ts', dir)).toEqual([{ file: realFile }]);
  });
});
