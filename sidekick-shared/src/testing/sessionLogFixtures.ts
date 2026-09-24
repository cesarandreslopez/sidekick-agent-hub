/**
 * Claude Code and Codex session-log builders shared by the prompt-history
 * tests. Test-only: excluded from the package build.
 */

import * as fs from 'fs';
import * as path from 'path';
import { encodeWorkspacePath as encodeClaudeWorkspacePath } from '../parsers/sessionPathResolver';

export type Row = Record<string, unknown>;

export function ts(second: number): string {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, second)).toISOString();
}

export function writeJsonl(file: string, rows: Row[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

export function appendJsonl(file: string, rows: Row[]): void {
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

/** A Claude Code line with no message: read and ignored, like progress records. */
export function claudeFiller(bytes: number, second: number): Row {
  return { type: 'system', subtype: 'filler', timestamp: ts(second), content: 'f'.repeat(bytes) };
}

/** A Codex line that is neither a prompt nor usage. */
export function codexFiller(bytes: number, second: number): Row {
  return {
    timestamp: ts(second),
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'f'.repeat(bytes) },
  };
}

export interface SessionLogFixtureContext {
  /** The mocked home directory holding `.claude/` and `.codex/`. */
  home: string;
  /** Default working directory recorded on Claude lines. */
  repo: string;
}

/** Builders that read the per-test home and repo lazily from `context`. */
export function createSessionLogFixtures(context: () => SessionLogFixtureContext) {
  let codexCounter = 0;

  function claudeFile(workspace: string, sessionId: string): string {
    return path.join(
      context().home,
      '.claude',
      'projects',
      encodeClaudeWorkspacePath(workspace),
      `${sessionId}.jsonl`,
    );
  }

  function claudeUser(content: unknown, second: number, extra: Row = {}): Row {
    return {
      type: 'user',
      entrypoint: 'cli',
      cwd: context().repo,
      gitBranch: 'main',
      timestamp: ts(second),
      message: { role: 'user', content },
      ...extra,
    };
  }

  /** One Claude Code assistant record; `message` fields are merged over the defaults. */
  function claudeAssistant(id: string, second: number, extra: Row = {}, message: Row = {}): Row {
    return {
      type: 'assistant',
      entrypoint: 'cli',
      cwd: context().repo,
      timestamp: ts(second),
      message: {
        id,
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
        ...message,
      },
      ...extra,
    };
  }

  function codexFile(): string {
    codexCounter++;
    const id = `019d86b0-b20c-7b02-a3b2-${String(codexCounter).padStart(12, '0')}`;
    return path.join(
      context().home,
      '.codex',
      'sessions',
      '2026',
      '09',
      '01',
      `rollout-2026-09-01T10-00-${String(codexCounter).padStart(2, '0')}-${id}.jsonl`,
    );
  }

  function codexMeta(cwd: string | undefined, source: unknown = 'cli', extra: Row = {}): Row {
    return {
      timestamp: ts(0),
      type: 'session_meta',
      payload: {
        id: 'meta',
        timestamp: ts(0),
        ...(cwd !== undefined ? { cwd } : {}),
        originator: 'codex-tui',
        source,
        git: { branch: 'feature/x' },
        ...extra,
      },
    };
  }

  function codexUser(texts: string[], second: number): Row {
    return {
      timestamp: ts(second),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: texts.map((text) => ({ type: 'input_text', text })),
      },
    };
  }

  function codexTokenCount(second: number): Row {
    return {
      timestamp: ts(second),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 7,
            cache_write_input_tokens: 5,
          },
        },
      },
    };
  }

  return {
    claudeFile,
    claudeUser,
    claudeAssistant,
    codexFile,
    codexMeta,
    codexUser,
    codexTokenCount,
  };
}
