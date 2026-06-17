/**
 * @fileoverview Compatibility re-exports for the shared JSONL parser.
 *
 * The canonical parser and extractors live in sidekick-shared. This shim keeps
 * older extension imports stable while avoiding a forked implementation.
 *
 * @module services/JsonlParser
 */

import type { ClaudeSessionEvent } from '../types/claudeSession';
import type { JsonlParserCallbacks } from 'sidekick-shared';

export { JsonlParser, extractTokenUsage, extractToolCall } from 'sidekick-shared';
export type JsonlParserOptions = JsonlParserCallbacks<ClaudeSessionEvent>;
