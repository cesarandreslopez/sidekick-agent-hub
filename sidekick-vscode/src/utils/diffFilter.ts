/**
 * @fileoverview Diff filtering utilities for commit message generation.
 *
 * Filters out binary files, lockfiles, and generated code from git diffs
 * to ensure Claude receives only relevant, clean diff content.
 *
 * @module diffFilter
 */

/**
 * Configuration options for diff filtering.
 */
export interface FilterOptions {
  /** Exclude binary files from diff output (default: true) */
  excludeBinary?: boolean;
  /** Exclude lockfiles from diff output (default: true) */
  excludeLockfiles?: boolean;
  /** Exclude generated code paths from diff output (default: true) */
  excludeGenerated?: boolean;
}

/**
 * Lockfile patterns to exclude from diffs.
 *
 * These files change automatically and don't provide useful context
 * for commit message generation.
 */
const LOCKFILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
];

/**
 * Generated code path patterns to exclude from diffs.
 *
 * These paths typically contain build artifacts or auto-generated code
 * that waste tokens without providing meaningful context.
 */
const GENERATED_PATTERNS = [
  /^dist\//,
  /^build\//,
  /^out\//,
  /^node_modules\//,
  /^\.next\//,
  /^\.nuxt\//,
  /\.generated\./,
  /\.codegen\./,
  /\.min\.(js|css)$/,
];

/**
 * Binary file extensions to exclude from diffs.
 *
 * Git marks these as "Binary files ... differ" but we also check
 * extensions for additional safety.
 */
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.rar',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.avi',
];

/**
 * Filters unwanted content from git diff output.
 *
 * Removes diff sections for binary files, lockfiles, and generated code
 * based on the provided options. Each section is parsed independently,
 * and excluded sections are completely removed from the output.
 *
 * @param diff - Raw git diff output
 * @param options - Filtering options (all exclusions default to true)
 * @returns Filtered diff with excluded sections removed
 *
 * @example
 * ```typescript
 * const diff = `diff --git a/src/index.ts b/src/index.ts
 * --- a/src/index.ts
 * +++ b/src/index.ts
 * @@ -1,3 +1,4 @@
 * +console.log('test');
 * diff --git a/package-lock.json b/package-lock.json
 * --- a/package-lock.json
 * +++ b/package-lock.json
 * ...lockfile changes...`;
 *
 * const filtered = filterDiff(diff);
 * // Returns only the src/index.ts section, lockfile excluded
 * ```
 */
export function filterDiff(diff: string, options?: FilterOptions): string {
  const opts: Required<FilterOptions> = {
    excludeBinary: options?.excludeBinary ?? true,
    excludeLockfiles: options?.excludeLockfiles ?? true,
    excludeGenerated: options?.excludeGenerated ?? true,
  };

  // Split diff into sections by "diff --git" markers
  // First section may be empty or contain header info
  const sections = diff.split(/^(?=diff --git )/m);
  const filteredSections: string[] = [];

  for (const section of sections) {
    // Empty section, skip
    if (!section.trim()) {
      continue;
    }

    // If section doesn't start with "diff --git", it's the header - keep it
    if (!section.startsWith('diff --git')) {
      filteredSections.push(section);
      continue;
    }

    // Extract filepath from "b/filepath" pattern
    const filepathMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!filepathMatch) {
      // Couldn't parse filepath, keep section to be safe
      filteredSections.push(section);
      continue;
    }

    const filepath = filepathMatch[1];

    // Check exclusion rules
    const isBinaryContent = opts.excludeBinary && section.includes('Binary files');
    const isBinaryExt = opts.excludeBinary && BINARY_EXTENSIONS.some(ext => filepath.endsWith(ext));
    const isLockfile = opts.excludeLockfiles && LOCKFILE_PATTERNS.some(pattern => pattern.test(filepath));
    const isGenerated = opts.excludeGenerated && GENERATED_PATTERNS.some(pattern => pattern.test(filepath));

    if (isBinaryContent || isBinaryExt || isLockfile || isGenerated) {
      continue;
    }

    filteredSections.push(section);
  }

  return filteredSections.join('');
}
