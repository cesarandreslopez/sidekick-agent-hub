/**
 * @fileoverview VS Code adapter for shared provider auto-detection.
 *
 * Filesystem heuristics live in sidekick-shared so the extension and CLI cannot
 * drift on platform paths, rotated Codex databases, or activity ordering.
 */

import * as vscode from 'vscode';
import { detectProvider as detectSharedProvider, type ProviderId } from 'sidekick-shared';
import { ClaudeCodeSessionProvider } from './ClaudeCodeSessionProvider';
import { OpenCodeSessionProvider } from './OpenCodeSessionProvider';
import { CodexSessionProvider } from './CodexSessionProvider';
import type { SessionProvider } from '../../types/sessionProvider';
import type { InferenceProviderId } from '../../types/inferenceProvider';
import { log } from '../Logger';

function createSessionProvider(providerId: ProviderId): SessionProvider {
  switch (providerId) {
    case 'opencode':
      return new OpenCodeSessionProvider();
    case 'codex':
      return new CodexSessionProvider();
    case 'claude-code':
    default:
      return new ClaudeCodeSessionProvider();
  }
}

function configuredProvider(value: string): ProviderId | 'auto' {
  return value === 'claude-code' || value === 'opencode' || value === 'codex' ? value : 'auto';
}

/** Resolves the configured or most recently active session provider. */
export function detectProvider(): SessionProvider {
  const preference = configuredProvider(
    vscode.workspace.getConfiguration('sidekick').get<string>('sessionProvider', 'auto'),
  );
  const providerId = detectSharedProvider(preference);
  log(
    `Session provider: ${providerId}${preference === 'auto' ? ' (shared auto-detection)' : ' (configured)'}`,
  );
  return createSessionProvider(providerId);
}

/** Maps shared session-provider detection to the equivalent inference provider. */
export function detectInferenceProvider(): InferenceProviderId {
  const providerId = detectSharedProvider('auto');
  const inferenceProvider = providerId === 'claude-code' ? 'claude-max' : providerId;
  log(`Inference provider auto-detect: ${inferenceProvider} (shared auto-detection)`);
  return inferenceProvider;
}
