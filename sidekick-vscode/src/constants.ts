/**
 * @fileoverview Centralized constants for the Sidekick VS Code extension.
 *
 * Consolidates magic numbers and configuration defaults that were
 * previously scattered as inline literals across the codebase.
 *
 * @module constants
 */

// ---------------------------------------------------------------------------
// Time conversions
// ---------------------------------------------------------------------------

/** Milliseconds in one second. */
export const MS_PER_SECOND = 1_000;

/** Milliseconds in one minute. */
export const MS_PER_MINUTE = 60_000;

/** Milliseconds in one hour. */
export const MS_PER_HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Timeouts (ms)
// ---------------------------------------------------------------------------

/** Default timeout for API requests across all inference clients. */
export const DEFAULT_REQUEST_TIMEOUT = 30_000;

/** Maximum timeout cap applied by TimeoutManager. */
export const MAX_TIMEOUT = 120_000;

/** Additional timeout added per KB of input context. */
export const TIMEOUT_PER_KB = 500;

/** Timeout multiplier on retry (50% increase). */
export const TIMEOUT_RETRY_MULTIPLIER = 1.5;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Max entries in the LRU completion cache. */
export const COMPLETION_CACHE_MAX_SIZE = 100;

/** TTL for completion cache entries (ms). */
export const COMPLETION_CACHE_TTL = 30_000;

/** Characters of prefix used in cache key generation. */
export const CACHE_KEY_PREFIX_LENGTH = 500;

/** Characters of suffix used in cache key generation. */
export const CACHE_KEY_SUFFIX_LENGTH = 200;

// ---------------------------------------------------------------------------
// Completion character limits (must match values in system prompts)
// ---------------------------------------------------------------------------

/** Max chars for single-line code completions. */
export const CODE_SINGLE_LINE_LIMIT = 500;

/** Max chars for multi-line code completions. */
export const CODE_MULTI_LINE_LIMIT = 800;

/** Max chars for single-line prose completions. */
export const PROSE_SINGLE_LINE_LIMIT = 2_000;

/** Max chars for multi-line prose completions. */
export const PROSE_MULTI_LINE_LIMIT = 3_000;

// ---------------------------------------------------------------------------
// Token / output limits
// ---------------------------------------------------------------------------

/** Max output tokens for interactive chat and review responses. */
export const MAX_TOKENS_CHAT = 2_000;

/** Max output tokens for PR descriptions and summaries. */
export const MAX_TOKENS_SUMMARY = 1_000;

/** Default context window size (tokens) for session summary. */
export { DEFAULT_CONTEXT_WINDOW } from 'sidekick-shared';

// ---------------------------------------------------------------------------
// UI timing
// ---------------------------------------------------------------------------

/** Debounce delay before firing inline completion requests (ms). */
export const COMPLETION_DEBOUNCE_MS = 300;

/** Interval for rotating header phrase in webviews (ms). */
export const PHRASE_ROTATION_INTERVAL = 60_000;

/** Interval for rotating empty-state phrase in webviews (ms). */
export const EMPTY_PHRASE_ROTATION_INTERVAL = 30_000;

/** Minimum interval between auto-persistence writes (ms). */
export const PERSIST_INTERVAL_MS = 30_000;

/** Debounce for knowledge candidate extraction (ms). */
export const KNOWLEDGE_EXTRACTION_DELAY = 2_000;

// ---------------------------------------------------------------------------
// Session monitoring
// ---------------------------------------------------------------------------

/** Max seen-hash entries before pruning. */
export const MAX_SEEN_HASHES = 10_000;

/** Max context timeline events retained. */
export const MAX_CONTEXT_TIMELINE = 500;

/** Max tokens for session analysis prompts. */
export const MAX_ANALYSIS_TOKENS = 3_000;

/** Max lines of code for AI review. */
export const MAX_REVIEW_LINES = 3_000;

/** Max timeline events shown in dashboard. */
export const MAX_DISPLAY_TIMELINE = 20;
