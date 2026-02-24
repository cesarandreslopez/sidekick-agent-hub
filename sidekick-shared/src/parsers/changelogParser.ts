/**
 * Parser for Keep a Changelog format markdown files.
 *
 * Extracts structured changelog entries with version, date, section headings,
 * and bullet items from standard changelog markdown.
 */

export interface ChangelogEntry {
  /** Semver version string, e.g. "0.12.3" */
  version: string;
  /** Release date in YYYY-MM-DD format */
  date: string;
  /** Grouped sections (Added, Fixed, Changed, etc.) with their bullet items */
  sections: { heading: string; items: string[] }[];
}

const VERSION_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/;
const SECTION_HEADING_RE = /^### (.+)/;
const BULLET_RE = /^- /;

/**
 * Parse a Keep a Changelog markdown string into structured entries.
 *
 * @param markdown - Raw changelog markdown content
 * @param limit - Maximum number of version entries to return (default 5)
 * @returns Array of parsed changelog entries, newest first
 */
export function parseChangelog(markdown: string, limit: number = 5): ChangelogEntry[] {
  const lines = markdown.split('\n');
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentSection: { heading: string; items: string[] } | null = null;

  for (const line of lines) {
    // Check for version heading
    const versionMatch = line.match(VERSION_HEADING_RE);
    if (versionMatch) {
      if (current) {
        if (currentSection && currentSection.items.length > 0) {
          current.sections.push(currentSection);
        }
        entries.push(current);
        if (entries.length >= limit) break;
      }
      current = { version: versionMatch[1], date: versionMatch[2], sections: [] };
      currentSection = null;
      continue;
    }

    if (!current) continue;

    // Check for section heading (### Added, ### Fixed, etc.)
    const sectionMatch = line.match(SECTION_HEADING_RE);
    if (sectionMatch) {
      if (currentSection && currentSection.items.length > 0) {
        current.sections.push(currentSection);
      }
      currentSection = { heading: sectionMatch[1], items: [] };
      continue;
    }

    if (!currentSection) continue;

    // Bullet item
    if (BULLET_RE.test(line)) {
      currentSection.items.push(line.slice(2).trim());
      continue;
    }

    // Continuation line (indented sub-bullet or wrapped text) — append to last item
    if (line.startsWith('  ') && currentSection.items.length > 0) {
      currentSection.items[currentSection.items.length - 1] += ' ' + line.trim();
    }
  }

  // Flush final entry
  if (current) {
    if (currentSection && currentSection.items.length > 0) {
      current.sections.push(currentSection);
    }
    if (entries.length < limit) {
      entries.push(current);
    }
  }

  return entries;
}
