/**
 * @fileoverview Re-exports OpenCode database wrapper from sidekick-shared.
 *
 * The full OpenCodeDatabase class with all query methods is now in sidekick-shared.
 * This file re-exports for backward compatibility within the VS Code extension.
 *
 * @module services/providers/OpenCodeDatabase
 */

export { OpenCodeDatabase } from 'sidekick-shared/dist/providers/openCodeDatabase';
