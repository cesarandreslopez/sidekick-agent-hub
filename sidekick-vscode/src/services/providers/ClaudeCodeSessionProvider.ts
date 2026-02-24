/**
 * @fileoverview Claude Code session provider (VS Code wrapper).
 *
 * Thin wrapper around the shared ClaudeCodeProvider, adding only
 * vscode.Disposable compliance for the VS Code SessionProvider interface.
 *
 * All parsing, path resolution, and session logic lives in sidekick-shared.
 *
 * @module services/providers/ClaudeCodeSessionProvider
 */

import { ClaudeCodeProvider } from 'sidekick-shared/dist/providers/claudeCode';
import type { SessionProvider } from '../../types/sessionProvider';

/**
 * Session provider for Claude Code CLI (VS Code integration).
 *
 * Inherits all functionality from the shared ClaudeCodeProvider.
 * The `implements SessionProvider` declaration ensures type compatibility
 * with the VS Code extension's provider interface (includes vscode.Disposable).
 */
export class ClaudeCodeSessionProvider extends ClaudeCodeProvider implements SessionProvider {}
