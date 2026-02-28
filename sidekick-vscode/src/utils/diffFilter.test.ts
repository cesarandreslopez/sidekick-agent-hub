/**
 * @fileoverview Tests for diffFilter — filtering binary, lockfiles, and generated code from diffs.
 *
 * @module diffFilter.test
 */

import { describe, it, expect } from 'vitest';
import { filterDiff, FilterOptions } from './diffFilter';

/** Helper to build a diff section for a given file. */
function makeDiffSection(filepath: string, body = '+some change\n'): string {
  return (
    `diff --git a/${filepath} b/${filepath}\n` +
    `--- a/${filepath}\n` +
    `+++ b/${filepath}\n` +
    '@@ -1,3 +1,4 @@\n' +
    body
  );
}

/** Helper to build a binary diff section. */
function makeBinarySection(filepath: string): string {
  return (
    `diff --git a/${filepath} b/${filepath}\n` +
    `Binary files a/${filepath} and b/${filepath} differ\n`
  );
}

describe('filterDiff', () => {
  // ── basics ────────────────────────────────────────────────────────

  describe('basic filtering', () => {
    it('returns empty string for empty input', () => {
      expect(filterDiff('')).toBe('');
    });

    it('returns whitespace-only input as empty', () => {
      expect(filterDiff('   \n  \n  ')).toBe('');
    });

    it('keeps a normal source file diff section', () => {
      const section = makeDiffSection('src/index.ts');
      expect(filterDiff(section)).toBe(section);
    });

    it('keeps multiple normal source file sections', () => {
      const diff =
        makeDiffSection('src/a.ts') +
        makeDiffSection('src/b.ts');
      expect(filterDiff(diff)).toBe(diff);
    });

    it('preserves header content before the first diff --git marker', () => {
      const header = 'commit abc123\nAuthor: test\n\n';
      const section = makeDiffSection('src/file.ts');
      const diff = header + section;
      expect(filterDiff(diff)).toBe(diff);
    });
  });

  // ── lockfile exclusion ────────────────────────────────────────────

  describe('lockfile exclusion', () => {
    const lockfiles = [
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'Gemfile.lock',
      'composer.lock',
      'Cargo.lock',
      'poetry.lock',
    ];

    for (const lockfile of lockfiles) {
      it(`excludes ${lockfile}`, () => {
        const diff =
          makeDiffSection('src/app.ts') +
          makeDiffSection(lockfile);

        const result = filterDiff(diff);
        expect(result).toContain('src/app.ts');
        expect(result).not.toContain(lockfile);
      });
    }

    it('keeps lockfiles when excludeLockfiles is false', () => {
      const diff =
        makeDiffSection('src/app.ts') +
        makeDiffSection('package-lock.json');

      const result = filterDiff(diff, { excludeLockfiles: false });
      expect(result).toContain('package-lock.json');
    });
  });

  // ── binary file exclusion ─────────────────────────────────────────

  describe('binary file exclusion', () => {
    it('excludes sections containing "Binary files" marker', () => {
      const diff =
        makeDiffSection('src/app.ts') +
        makeBinarySection('logo.png');

      const result = filterDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).not.toContain('logo.png');
    });

    const binaryExtensions = [
      'image.png', 'photo.jpg', 'pic.jpeg', 'anim.gif', 'icon.ico', 'hero.webp',
      'doc.pdf', 'archive.zip', 'archive.tar', 'data.gz', 'backup.rar',
      'app.exe', 'lib.dll', 'lib.so', 'lib.dylib',
      'font.woff', 'font.woff2', 'font.ttf', 'font.eot',
      'song.mp3', 'video.mp4', 'sound.wav', 'clip.avi',
    ];

    for (const file of binaryExtensions) {
      it(`excludes binary extension file: ${file}`, () => {
        const diff =
          makeDiffSection('src/app.ts') +
          makeDiffSection(`assets/${file}`);

        const result = filterDiff(diff);
        expect(result).not.toContain(file);
      });
    }

    it('keeps binary files when excludeBinary is false', () => {
      const diff =
        makeDiffSection('src/app.ts') +
        makeBinarySection('logo.png');

      const result = filterDiff(diff, { excludeBinary: false });
      expect(result).toContain('logo.png');
    });
  });

  // ── generated code exclusion ──────────────────────────────────────

  describe('generated code exclusion', () => {
    const generatedPaths = [
      'dist/bundle.js',
      'build/output.js',
      'out/extension.js',
      'node_modules/lodash/index.js',
      '.next/cache/data.json',
      '.nuxt/components.json',
      'src/types.generated.ts',
      'src/api.codegen.ts',
      'vendor/lib.min.js',
      'styles/main.min.css',
    ];

    for (const path of generatedPaths) {
      it(`excludes generated path: ${path}`, () => {
        const diff =
          makeDiffSection('src/app.ts') +
          makeDiffSection(path);

        const result = filterDiff(diff);
        expect(result).toContain('src/app.ts');
        expect(result).not.toContain(path);
      });
    }

    it('keeps generated paths when excludeGenerated is false', () => {
      const diff =
        makeDiffSection('src/app.ts') +
        makeDiffSection('dist/bundle.js');

      const result = filterDiff(diff, { excludeGenerated: false });
      expect(result).toContain('dist/bundle.js');
    });
  });

  // ── option combinations ───────────────────────────────────────────

  describe('option combinations', () => {
    it('defaults all exclusions to true', () => {
      const diff =
        makeDiffSection('src/app.ts') +
        makeDiffSection('package-lock.json') +
        makeBinarySection('logo.png') +
        makeDiffSection('dist/bundle.js');

      const result = filterDiff(diff);
      expect(result).toContain('src/app.ts');
      expect(result).not.toContain('package-lock.json');
      expect(result).not.toContain('logo.png');
      expect(result).not.toContain('dist/bundle.js');
    });

    it('can disable all exclusions', () => {
      const opts: FilterOptions = {
        excludeBinary: false,
        excludeLockfiles: false,
        excludeGenerated: false,
      };

      const diff =
        makeDiffSection('src/app.ts') +
        makeDiffSection('package-lock.json') +
        makeBinarySection('logo.png') +
        makeDiffSection('dist/bundle.js');

      const result = filterDiff(diff, opts);
      expect(result).toContain('src/app.ts');
      expect(result).toContain('package-lock.json');
      expect(result).toContain('logo.png');
      expect(result).toContain('dist/bundle.js');
    });
  });

  // ── edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('keeps section when filepath cannot be parsed', () => {
      // Malformed diff header without b/ path
      const malformed = 'diff --git malformed\n+some content\n';
      expect(filterDiff(malformed)).toBe(malformed);
    });

    it('handles diff with only excluded files — returns empty', () => {
      const diff =
        makeDiffSection('package-lock.json') +
        makeBinarySection('image.png');

      expect(filterDiff(diff)).toBe('');
    });

    it('does not confuse partial filename matches', () => {
      // "my-package-lock.json.bak" should NOT match lockfile pattern
      const diff = makeDiffSection('my-package-lock.json.bak');
      expect(filterDiff(diff)).toContain('my-package-lock.json.bak');
    });

    it('handles nested generated paths correctly', () => {
      // "src/dist/thing.ts" — dist is not at root, so should NOT be excluded
      // The pattern ^dist/ only matches paths starting with dist/
      const diff = makeDiffSection('src/dist/thing.ts');
      expect(filterDiff(diff)).toContain('src/dist/thing.ts');
    });

    it('handles deeply nested lockfile', () => {
      // "packages/sub/package-lock.json" — ends with package-lock.json
      const diff = makeDiffSection('packages/sub/package-lock.json');
      expect(filterDiff(diff)).toBe('');
    });

    it('handles diff sections with no changes', () => {
      const section = makeDiffSection('src/empty.ts', '');
      expect(filterDiff(section)).toBe(section);
    });
  });
});
