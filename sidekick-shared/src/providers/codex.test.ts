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
  fs.writeFileSync(sessionPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

describe('CodexProvider', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-provider-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores parser context and a partial Unicode line from a committed cursor', async () => {
    const filename = path.join(tmpDir, 'rollout-checkpoint.jsonl');
    const line = (row: unknown) => Buffer.from(JSON.stringify(row) + '\n');
    const prefix = Buffer.concat([
      line({ type: 'session_meta', payload: { id: 'session', cwd: tmpDir } }),
      line({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: tmpDir } }),
    ]);
    const final = line({
      type: 'response_item',
      timestamp: '2026-09-06T12:00:00Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'café ☕' }],
      },
    });
    const split = final.indexOf(Buffer.from('é')) + 1;
    fs.writeFileSync(filename, Buffer.concat([prefix, final.subarray(0, split)]));
    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();
    const { ProviderReaderSessionWatcher } = await import('../watchers/providerReaderWatcher');
    const followed: string[] = [];
    const watcher = new ProviderReaderSessionWatcher(provider, filename, {
      onEvent: (event) => followed.push(event.summary),
    });
    try {
      watcher.start(true);
      watcher.stop();
      const live = provider.createReader(filename);
      live.readNew();
      expect(live.getPosition()).toBe(prefix.length);
      const restored = provider.createReader(filename);
      restored.seekTo(live.getPosition());
      fs.appendFileSync(filename, final.subarray(split));
      watcher.start(true);
      expect(followed.at(-1)).toBe('café ☕');
      const events = restored.readNew();
      expect(events).toEqual(live.readNew());
      expect(events).toMatchObject([
        { message: { model: 'gpt-5-codex', content: [{ text: 'café ☕' }] } },
      ]);
      expect(restored.getPosition()).toBe(prefix.length + final.length);
    } finally {
      watcher.stop();
      provider.dispose();
    }
  });

  it('records the reported context window against the session model', async () => {
    // Codex reports a tier-specific model_context_window on every token_count
    // event. It must be persisted per model so historical views don't fall back
    // to the catalog's much larger published maximum.
    const sessionPath = path.join(tmpDir, '.codex', 'sessions', 'rollout-observed.jsonl');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(
      sessionPath,
      [
        {
          timestamp: '2026-07-01T12:00:00.000Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', cwd: tmpDir },
        },
        {
          timestamp: '2026-07-01T12:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 258_400,
              last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();
    const reader = provider.createReader(sessionPath);
    reader.readNew();

    // Live sessions keep using the runtime value directly.
    expect(provider.getContextWindowLimit('gpt-5.6-sol')).toBe(258_400);

    // ...and it is persisted for later, keyed by the model from turn_context.
    const storePath = path.join(tmpDir, 'observed-context-windows.json');
    await vi.waitFor(() => expect(fs.existsSync(storePath)).toBe(true));
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(store.models['gpt-5.6-sol'].contextWindow).toBe(258_400);
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
    const sessionPath = path.join(
      tmpDir,
      '.codex',
      'sessions',
      '2026',
      '06',
      '01',
      'rollout-2026-06-01T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl',
    );
    writeRichRolloutSession(sessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();

    const hits = provider.searchInSession(sessionPath, 'needle', 10);
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(hits.map((h) => h.line).join(' ')).toContain('Base audit needle');
    expect(hits.map((h) => h.line).join(' ')).toContain('Developer audit needle');
    expect(hits.map((h) => h.line).join(' ')).toContain('Read output needle');
  });

  it('reads stats from canonical Codex reader events', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    const sessionPath = path.join(
      tmpDir,
      '.codex',
      'sessions',
      '2026',
      '06',
      '01',
      'rollout-2026-06-01T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl',
    );
    writeRichRolloutSession(sessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();
    const stats = provider.readSessionStats(sessionPath);

    expect(stats.messageCount).toBe(6);
    expect(stats.tokens).toMatchObject({ input: 800, output: 300, cacheRead: 400 });
    expect(stats.modelUsage['gpt-5-codex']).toMatchObject({ calls: 1, tokens: 1500 });
    expect(stats.toolUsage.Read).toBe(1);
    expect(stats.toolUsage.Edit).toBe(1);
  });

  it('reconstructs context size from normalized uncached and cached input', async () => {
    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();

    expect(
      provider.computeContextSize({
        inputTokens: 800,
        outputTokens: 300,
        cacheWriteTokens: 0,
        cacheReadTokens: 400,
        reasoningTokens: 100,
        model: 'gpt-5-codex',
        timestamp: new Date(),
      }),
    ).toBe(1200);
  });

  it('replays Codex sessions through the provider-reader watcher', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    fs.mkdirSync(workspacePath, { recursive: true });
    const sessionPath = path.join(
      tmpDir,
      '.codex',
      'sessions',
      '2026',
      '06',
      '01',
      'rollout-2026-06-01T12-00-00-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl',
    );
    writeRichRolloutSession(sessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const { createWatcher } = await import('../watchers/factory');
    const provider = new CodexProvider();
    const events: Array<{ type: string; summary: string; rateLimits?: unknown }> = [];
    const result = createWatcher({
      provider,
      workspacePath,
      callbacks: {
        onEvent: (event) => events.push(event),
      },
    });

    result.watcher.start(true);
    result.watcher.stop();

    expect(result.sessionPath).toBe(sessionPath);
    expect(events.some((e) => e.type === 'system' && e.summary.includes('base instructions'))).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'tool_use' && e.summary.includes('Read'))).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.summary.includes('Read output'))).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'system' && e.rateLimits)).toBe(true);
  });
});

describe('findCodexRolloutFile', () => {
  const uuid = '019d86b0-b20c-7b02-a3b2-efe5c1ed7122';
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-rollout-find-'));
    previousCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRollout(home: string, daySegments: string[], name: string): string {
    const rolloutPath = path.join(home, 'sessions', ...daySegments, name);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '{}\n');
    return rolloutPath;
  }

  it('finds a rollout by session id in the dated tree', async () => {
    const { findCodexRolloutFile } = await import('./codex');
    const expected = writeRollout(
      path.join(tmpDir, '.codex'),
      ['2026', '08', '18'],
      `rollout-2026-08-18T13-31-03-${uuid}.jsonl`,
    );

    expect(findCodexRolloutFile(uuid)).toBe(expected);
  });

  it('matches the id case-insensitively', async () => {
    const { findCodexRolloutFile } = await import('./codex');
    const expected = writeRollout(
      path.join(tmpDir, '.codex'),
      ['2026', '08', '18'],
      `rollout-2026-08-18T13-31-03-${uuid}.jsonl`,
    );

    expect(findCodexRolloutFile(uuid.toUpperCase())).toBe(expected);
  });

  it('returns null for unknown, empty, and whitespace ids', async () => {
    const { findCodexRolloutFile } = await import('./codex');
    writeRollout(
      path.join(tmpDir, '.codex'),
      ['2026', '08', '18'],
      `rollout-2026-08-18T13-31-03-${uuid}.jsonl`,
    );

    expect(findCodexRolloutFile('019d86b0-0000-0000-0000-000000000000')).toBeNull();
    // The empty-id guard is critical: a suffix predicate without it would
    // match every rollout file.
    expect(findCodexRolloutFile('')).toBeNull();
    expect(findCodexRolloutFile('   ')).toBeNull();
  });

  it('returns null when the sessions tree does not exist', async () => {
    const { findCodexRolloutFile } = await import('./codex');

    expect(findCodexRolloutFile(uuid)).toBeNull();
    expect(findCodexRolloutFile(uuid, { codexHome: path.join(tmpDir, 'missing') })).toBeNull();
  });

  it('restricts the search to an explicit codexHome', async () => {
    const { findCodexRolloutFile } = await import('./codex');
    writeRollout(
      path.join(tmpDir, '.codex'),
      ['2026', '08', '18'],
      `rollout-2026-08-18T13-31-03-${uuid}.jsonl`,
    );
    const otherHome = path.join(tmpDir, 'other-home');
    const inOther = writeRollout(
      otherHome,
      ['2026', '08', '17'],
      `rollout-2026-08-17T09-00-00-${uuid}.jsonl`,
    );

    expect(findCodexRolloutFile(uuid, { codexHome: otherHome })).toBe(inOther);
    expect(findCodexRolloutFile(uuid, { codexHome: path.join(tmpDir, 'empty-home') })).toBeNull();
  });

  it('prefers the most recently modified copy when the id appears twice', async () => {
    const { findCodexRolloutFile } = await import('./codex');
    const home = path.join(tmpDir, '.codex');
    const older = writeRollout(home, ['2026', '08', '17'], `rollout-a-${uuid}.jsonl`);
    const newer = writeRollout(home, ['2026', '08', '18'], `rollout-b-${uuid}.jsonl`);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);

    expect(findCodexRolloutFile(uuid)).toBe(newer);
  });

  it('ignores malformed neighbors and accepts timestampless rollout names', async () => {
    const { findCodexRolloutFile } = await import('./codex');
    const home = path.join(tmpDir, '.codex');
    writeRollout(home, ['2026', '08', '18'], 'notes.jsonl');
    writeRollout(home, ['2026', '08', '18'], 'rollout-garbage.jsonl');
    const bare = writeRollout(home, ['2026', '08', '18'], `rollout-${uuid}.jsonl`);

    expect(findCodexRolloutFile(uuid)).toBe(bare);
  });
});
