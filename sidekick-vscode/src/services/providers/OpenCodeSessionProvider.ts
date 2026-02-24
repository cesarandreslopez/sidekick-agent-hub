/**
 * @fileoverview OpenCode session provider (VS Code wrapper).
 *
 * Thin wrapper around the shared OpenCodeProvider, adding only
 * vscode.Disposable compliance for the VS Code SessionProvider interface.
 *
 * All DB access, message parsing, and session logic lives in sidekick-shared.
 *
 * @module services/providers/OpenCodeSessionProvider
 */

import { OpenCodeProvider } from 'sidekick-shared/dist/providers/openCode';
import type { SessionProvider } from '../../types/sessionProvider';

/**
 * Session provider for OpenCode CLI (VS Code integration).
 *
 * Inherits all functionality from the shared OpenCodeProvider, including
 * DB-backed reading, file-based fallback, context attribution, and
 * usage snapshot support.
 */
export class OpenCodeSessionProvider extends OpenCodeProvider implements SessionProvider {}
