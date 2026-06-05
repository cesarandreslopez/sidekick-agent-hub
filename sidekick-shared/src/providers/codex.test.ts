import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

vi.mock('./codexDatabase', () => ({
  CodexDatabase: class {
    isAvailable(): boolean {
      return false;
    }

    open(): boolean {
      return false;
    }

    close(): void {}
  },
}));

function writeRolloutSession(sessionPath: string, cwd: string): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({
      timestamp: '2026-04-13T11:54:30.705Z',
      type: 'session_meta',
      payload: {
        id: '019d86b0-b20c-7b02-a3b2-efe5c1ed7122',
        timestamp: '2026-04-13T11:53:40.113Z',
        cwd,
        originator: 'codex-tui',
        source: 'cli',
      },
    }) + '\n',
  );
}

function writeRichRolloutSession(sessionPath: string, cwd: string): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const rows = [
    {
      timestamp: '2026-06-01T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '019d86b0-b20c-7b02-a3b2-efe5c1ed7122',
        cwd,
        source: 'cli',
        base_instructions: { text: 'Base audit needle instructions.' },
      },
    },
    {
      timestamp: '2026-06-01T12:00:01.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5-codex', cwd },
    },
    {
      timestamp: '2026-06-01T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Developer audit needle.' }],
      },
    },
    {
      timestamp: '2026-06-01T12:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Please inspect the code.' }],
      },
    },
    {
      timestamp: '2026-06-01T12:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will inspect it.' }],
      },
    },
    {
      timestamp: '2026-06-01T12:00:05.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-read',
        name: 'Read',
        arguments: '{"file_path":"src/index.ts","query":"needle"}',
      },
    },
    {
      timestamp: '2026-06-01T12:00:06.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-read',
        output: 'Read output needle',
      },
    },
    {
      timestamp: '2026-06-01T12:00:07.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'patch-1',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: src/index.ts\n@@\n-old\n+new\n*** End Patch',
      },
    },
    {
      timestamp: '2026-06-01T12:00:08.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'patch-1',
        output: '{"metadata":{"exit_code":0,"duration_seconds":0.2}}',
      },
    },
    {
      timestamp: '2026-06-01T12:00:09.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cached_input_tokens: 400,
          },
        },
        rate_limits: {
          primary: { used_percent: 65, window_minutes: 300, resets_at: 1790000000 },
        },
      },
    },
  ];
  fs.writeFileSync(sessionPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

describe('CodexProvider', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-provider-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to the system ~/.codex sessions when the active managed profile home is empty', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    fs.mkdirSync(workspacePath, { recursive: true });

    const { getCodexProfileHome } = await import('../codexProfiles');
    const { upsertSavedAccountProfile, setActiveSavedAccount } = await import('../accountRegistry');

    const profileId = 'profile-1';
    fs.mkdirSync(getCodexProfileHome(profileId), { recursive: true });
    upsertSavedAccountProfile({
      id: profileId,
      providerId: 'codex',
      addedAt: '2026-04-13T11:48:16.244Z',
      label: 'cal',
      email: 'user@example.com',
    });
    setActiveSavedAccount('codex', profileId);

    const systemSessionPath = path.join(
      tmpDir,
      '.codex',
      'sessions',
      '2026',
      '04',
      '13',
      'rollout-2026-04-13T14-53-40-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl',
    );
    writeRolloutSession(systemSessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();

    expect(provider.findActiveSession(workspacePath)).toBe(systemSessionPath);
    expect(provider.findAllSessions(workspacePath)).toEqual([systemSessionPath]);
    expect(provider.discoverSessionDirectory(workspacePath)).toBe(path.dirname(systemSessionPath));
  });

  it('searches direct Codex payload shapes including audit context and tool outputs', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    const sessionPath = path.join(tmpDir, '.codex', 'sessions', '2026', '06', '01', 'rollout-2026-06-01T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl');
    writeRichRolloutSession(sessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();

    const hits = provider.searchInSession(sessionPath, 'needle', 10);
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(hits.map(h => h.line).join(' ')).toContain('Base audit needle');
    expect(hits.map(h => h.line).join(' ')).toContain('Developer audit needle');
    expect(hits.map(h => h.line).join(' ')).toContain('Read output needle');
  });

  it('reads stats from canonical Codex reader events', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    const sessionPath = path.join(tmpDir, '.codex', 'sessions', '2026', '06', '01', 'rollout-2026-06-01T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl');
    writeRichRolloutSession(sessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();
    const stats = provider.readSessionStats(sessionPath);

    expect(stats.messageCount).toBe(6);
    expect(stats.tokens).toMatchObject({ input: 1200, output: 300, cacheRead: 400 });
    expect(stats.modelUsage['gpt-5-codex']).toMatchObject({ calls: 1, tokens: 1500 });
    expect(stats.toolUsage.Read).toBe(1);
    expect(stats.toolUsage.Edit).toBe(1);
  });

  it('replays Codex sessions through the provider-reader watcher', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    fs.mkdirSync(workspacePath, { recursive: true });
    const sessionPath = path.join(tmpDir, '.codex', 'sessions', '2026', '06', '01', 'rollout-2026-06-01T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl');
    writeRichRolloutSession(sessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const { createWatcher } = await import('../watchers/factory');
    const provider = new CodexProvider();
    const events: Array<{ type: string; summary: string; rateLimits?: unknown }> = [];
    const result = createWatcher({
      provider,
      workspacePath,
      callbacks: {
        onEvent: event => events.push(event),
      },
    });

    result.watcher.start(true);
    result.watcher.stop();

    expect(result.sessionPath).toBe(sessionPath);
    expect(events.some(e => e.type === 'system' && e.summary.includes('base instructions'))).toBe(true);
    expect(events.some(e => e.type === 'tool_use' && e.summary.includes('Read'))).toBe(true);
    expect(events.some(e => e.type === 'tool_result' && e.summary.includes('Read output'))).toBe(true);
    expect(events.some(e => e.type === 'system' && e.rateLimits)).toBe(true);
  });
});
