/**
 * @fileoverview Re-exports Codex database wrapper from sidekick-shared.
 *
 * The full CodexDatabase class with all query methods is now in sidekick-shared.
 * This file re-exports for backward compatibility within the VS Code extension.
 *
 * @module services/providers/CodexDatabase
 */

export { CodexDatabase } from 'sidekick-shared/dist/providers/codexDatabase';
