/**
 * Multi-mode filter engine for session events.
 *
 * Supports 4 filter modes: substring, fuzzy, regex, and date range.
 * Provides both filtering and match highlighting for CLI (blessed) and VS Code (HTML).
 *
 * @module search/advancedFilter
 */

import type { FollowEvent } from '../watchers/types';

export type FilterMode = 'substring' | 'fuzzy' | 'regex' | 'date';

export interface FilterState {
  mode: FilterMode;
  query: string;
  /** For date mode: ISO timestamp lower bound. */
  since?: string;
  /** For date mode: ISO timestamp upper bound. */
  until?: string;
}

export type HighlightFormat = 'blessed' | 'ansi' | 'html';

export class FilterEngine {
  private mode: FilterMode = 'substring';
  private query = '';
  private since: string | undefined;
  private until: string | undefined;

  // Cached compiled regex
  private compiledRegex: RegExp | null = null;
  private regexError: string | null = null;

  // Cached fuzzy words
  private fuzzyWords: string[] = [];

  /** Set the active filter mode. */
  setMode(mode: FilterMode): void {
    this.mode = mode;
    this.recompile();
  }

  /** Set the query string (used by substring, fuzzy, regex modes). */
  setQuery(text: string): void {
    this.query = text;
    this.recompile();
  }

  /** Set date range bounds (used by date mode). */
  setDateRange(since?: string, until?: string): void {
    this.since = since;
    this.until = until;
  }

  /** Get the current filter state. */
  getState(): FilterState {
    return { mode: this.mode, query: this.query, since: this.since, until: this.until };
  }

  /** Whether the current regex is valid (always true for non-regex modes). */
  get isValid(): boolean {
    if (this.mode !== 'regex') return true;
    return this.regexError === null;
  }

  /** Regex compilation error, or null if valid. */
  get error(): string | null {
    return this.mode === 'regex' ? this.regexError : null;
  }

  /** Whether the filter has an active query. */
  get isActive(): boolean {
    if (this.mode === 'date') return !!(this.since || this.until);
    return this.query.length > 0;
  }

  /** Test whether a FollowEvent matches the current filter. */
  matches(event: FollowEvent): boolean {
    if (!this.isActive) return true;

    switch (this.mode) {
      case 'substring':
        return this.matchSubstring(event.summary);
      case 'fuzzy':
        return this.matchFuzzy(event.summary);
      case 'regex':
        return this.matchRegex(event.summary);
      case 'date':
        return this.matchDate(event.timestamp);
      default:
        return true;
    }
  }

  /** Test whether arbitrary text matches the current filter (for PanelItem labels etc). */
  matchesText(text: string): boolean {
    if (!this.isActive) return true;

    switch (this.mode) {
      case 'substring':
        return this.matchSubstring(text);
      case 'fuzzy':
        return this.matchFuzzy(text);
      case 'regex':
        return this.matchRegex(text);
      case 'date':
        return true; // date mode doesn't filter text
      default:
        return true;
    }
  }

  /**
   * Highlight matched portions of text in the given format.
   * Returns the text with matched substrings wrapped in highlight tags.
   */
  highlightMatches(text: string, format: HighlightFormat): string {
    if (!this.isActive || !text) return text;

    switch (this.mode) {
      case 'substring':
        return this.highlightSubstring(text, format);
      case 'fuzzy':
        return this.highlightFuzzy(text, format);
      case 'regex':
        return this.highlightRegex(text, format);
      case 'date':
        return text; // no highlighting for date mode
      default:
        return text;
    }
  }

  // ── Private: matching ──

  private matchSubstring(text: string): boolean {
    return text.includes(this.query);
  }

  private matchFuzzy(text: string): boolean {
    const lower = text.toLowerCase();
    return this.fuzzyWords.every(w => lower.includes(w));
  }

  private matchRegex(text: string): boolean {
    if (!this.compiledRegex) return false;
    this.compiledRegex.lastIndex = 0;
    return this.compiledRegex.test(text);
  }

  private matchDate(timestamp: string): boolean {
    if (this.since && timestamp < this.since) return false;
    if (this.until && timestamp > this.until) return false;
    return true;
  }

  // ── Private: highlighting ──

  private highlightSubstring(text: string, format: HighlightFormat): string {
    if (!this.query) return text;
    return this.wrapMatches(text, this.escapeRegex(this.query), format);
  }

  private highlightFuzzy(text: string, format: HighlightFormat): string {
    if (this.fuzzyWords.length === 0) return text;
    // Highlight each fuzzy word independently
    const pattern = this.fuzzyWords.map(w => this.escapeRegex(w)).join('|');
    return this.wrapMatches(text, pattern, format, 'gi');
  }

  private highlightRegex(text: string, format: HighlightFormat): string {
    if (!this.compiledRegex) return text;
    return this.wrapMatches(text, this.query, format, 'g');
  }

  private wrapMatches(text: string, pattern: string, format: HighlightFormat, flags = 'g'): string {
    let regex: RegExp;
    try {
      regex = new RegExp(`(${pattern})`, flags);
    } catch {
      return text;
    }

    const [open, close] = this.getHighlightTags(format);
    return text.replace(regex, `${open}$1${close}`);
  }

  private getHighlightTags(format: HighlightFormat): [string, string] {
    switch (format) {
      case 'blessed':
        return ['{blue-bg}{white-fg}', '{/white-fg}{/blue-bg}'];
      case 'ansi':
        return ['\x1b[0;44m', '\x1b[0m'];
      case 'html':
        return ['<mark class="sk-search-match">', '</mark>'];
      default:
        return ['', ''];
    }
  }

  // ── Private: compilation ──

  private recompile(): void {
    // Reset cached state
    this.compiledRegex = null;
    this.regexError = null;
    this.fuzzyWords = [];

    switch (this.mode) {
      case 'regex':
        try {
          this.compiledRegex = new RegExp(this.query, 'g');
          this.regexError = null;
        } catch (e) {
          this.regexError = e instanceof Error ? e.message : 'Invalid regex';
        }
        break;
      case 'fuzzy':
        this.fuzzyWords = this.query
          .toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 0);
        break;
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
