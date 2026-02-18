/**
 * @fileoverview Provider-aware instruction file targeting.
 *
 * Different CLI agents read different instruction files:
 * - Claude Code: reads CLAUDE.md natively
 * - OpenCode: prefers AGENTS.md, falls back to CLAUDE.md
 * - Codex: reads AGENTS.md natively
 *
 * This module provides type-safe resolution of which file to target
 * for guidance suggestions based on the active session provider.
 *
 * @module types/instructionFile
 */

/** Supported instruction file names. */
export type InstructionFileName = 'CLAUDE.md' | 'AGENTS.md';

/**
 * Describes which instruction file to target for a given provider.
 */
export interface InstructionFileTarget {
  /** The file this provider primarily reads */
  primaryFile: InstructionFileName;
  /** The other file (shown as secondary context) */
  secondaryFile: InstructionFileName;
  /** Display name for UI labels (same as primaryFile) */
  displayName: string;
  /** Provider-specific tip shown after suggestions */
  tip: string;
  /** Message shown when the target file doesn't exist */
  notFoundMessage: string;
  /** URL for best practices documentation */
  docsUrl: string;
}

/**
 * Resolves the instruction file target for a given session provider.
 *
 * @param providerId - The active session provider
 * @returns The instruction file target configuration
 */
export function resolveInstructionTarget(
  providerId: 'claude-code' | 'opencode' | 'codex'
): InstructionFileTarget {
  switch (providerId) {
    case 'claude-code':
      return {
        primaryFile: 'CLAUDE.md',
        secondaryFile: 'AGENTS.md',
        displayName: 'CLAUDE.md',
        tip: 'After adding suggestions to your CLAUDE.md, run /init in Claude Code to consolidate and optimize the file.',
        notFoundMessage: 'No CLAUDE.md found. Run /init in Claude Code to create one, or run: touch CLAUDE.md',
        docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/memory#claudemd',
      };

    case 'opencode':
      return {
        primaryFile: 'AGENTS.md',
        secondaryFile: 'CLAUDE.md',
        displayName: 'AGENTS.md',
        tip: 'OpenCode reads AGENTS.md for project-specific instructions. It falls back to CLAUDE.md if AGENTS.md is not found.',
        notFoundMessage: 'No AGENTS.md found. Ask OpenCode to create one, or run: touch AGENTS.md',
        docsUrl: 'https://github.com/opencode-ai/opencode',
      };

    case 'codex':
      return {
        primaryFile: 'AGENTS.md',
        secondaryFile: 'CLAUDE.md',
        displayName: 'AGENTS.md',
        tip: 'Codex reads AGENTS.md for project-specific agent instructions.',
        notFoundMessage: 'No AGENTS.md found. Ask Codex to create one, or run: touch AGENTS.md',
        docsUrl: 'https://github.com/openai/codex',
      };
  }
}
