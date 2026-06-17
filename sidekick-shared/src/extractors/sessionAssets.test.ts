import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dedupeAssets, extractCommands, extractFilePaths, extractUrls } from './sessionAssets';

describe('extractUrls', () => {
  it('extracts http, https, and file URLs without trailing punctuation', () => {
    const text = 'see https://example.com/path. Then http://foo.test/bar, and file:///tmp/x';

    expect(extractUrls(text)).toEqual([
      'https://example.com/path',
      'http://foo.test/bar',
      'file:///tmp/x',
    ]);
  });

  it('returns an empty list for nullish or empty input', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls(undefined)).toEqual([]);
    expect(extractUrls(null)).toEqual([]);
  });
});

describe('extractCommands', () => {
  it('extracts commands from shell-tagged fenced blocks', () => {
    const text = '```bash\nnpm run build\nnpm test\n```';

    expect(extractCommands(text)).toEqual(['npm run build', 'npm test']);
  });

  it('keeps explicit prompt-prefixed commands in untagged blocks and prose', () => {
    const text = '```\nnot a command\n$ pnpm test\n```\nThen run:\n$ git status';

    expect(extractCommands(text)).toEqual(['pnpm test', 'git status']);
  });

  it('joins shell line continuations and skips comments', () => {
    const text = '```sh\n# build it\ndocker run \\\n  --rm hello\n```';

    expect(extractCommands(text)).toEqual(['docker run --rm hello']);
  });
});

describe('extractFilePaths', () => {
  let dir: string;
  let realFile: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-assets-'));
    realFile = path.join(dir, 'src.ts');
    fs.writeFileSync(realFile, '// hi');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns only file paths that exist on disk', () => {
    const text = `edit ${realFile} and ${path.join(dir, 'missing.ts')}`;

    expect(extractFilePaths(text, dir)).toEqual([{ file: realFile }]);
  });

  it('resolves relative paths and preserves line suffixes', () => {
    expect(extractFilePaths('see src.ts:42:7', dir)).toEqual([{ file: realFile, line: 42 }]);
  });
});

describe('dedupeAssets', () => {
  it('dedupes by type and text while preserving first provenance metadata', () => {
    const assets = dedupeAssets([
      {
        type: 'url',
        text: 'https://example.test',
        display: 'https://example.test',
        agent: 'claude',
        sessionPath: '/tmp/claude.jsonl',
      },
      {
        type: 'url',
        text: 'https://example.test',
        display: 'https://example.test',
        agent: 'codex',
        sessionPath: '/tmp/codex.jsonl',
      },
    ]);

    expect(assets).toEqual([
      {
        type: 'url',
        text: 'https://example.test',
        display: 'https://example.test',
        agent: 'claude',
        sessionPath: '/tmp/claude.jsonl',
      },
    ]);
  });
});
