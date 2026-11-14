import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyAgentTranscriptPath, readAgentModel, readAgentVersion } from './agentPaths';

const UUID = '019d86b0-b20c-7b02-a3b2-000000000001';
let root: string;
let claudeHome: string;
let codexHome: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-agent-paths-')));
  claudeHome = path.join(root, 'claude');
  codexHome = path.join(root, 'codex');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('classifyAgentTranscriptPath', () => {
  const homes = () => ({ claudeHomes: [claudeHome], codexHomes: [codexHome] });

  it('classifies the relative path an empty CLAUDE_CONFIG_DIR session reports, per base', () => {
    // Claude Code 2.1.316+ with CLAUDE_CONFIG_DIR='' writes under its start
    // folder and reports `projects/<dir>/<id>.jsonl` relative to it.
    const projectDir = path.join(root, 'work', 'app');
    const elsewhere = path.join(root, 'elsewhere');
    const env = { CLAUDE_CONFIG_DIR: '', HOME: root };
    const relative = path.join('projects', '-work-app', 's-1.jsonl');
    // Before the transcript exists, the first base is reported.
    expect(
      classifyAgentTranscriptPath(relative, { env, baseDirs: [projectDir, elsewhere] }),
    ).toEqual({ provider: 'claude-code', kind: 'session', home: projectDir, sessionId: 's-1' });
    // Once it exists, the base that holds it wins, whatever its position.
    fs.mkdirSync(path.join(projectDir, 'projects', '-work-app'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, relative), '{}\n');
    expect(
      classifyAgentTranscriptPath(relative, { env, baseDirs: [elsewhere, projectDir] }),
    ).toEqual({ provider: 'claude-code', kind: 'session', home: projectDir, sessionId: 's-1' });
    expect(
      classifyAgentTranscriptPath(
        path.join('projects', '-work-app', 's-1', 'subagents', 'agent-a1.jsonl'),
        { env, baseDirs: [projectDir] },
      ),
    ).toEqual({
      provider: 'claude-code',
      kind: 'subagent',
      home: projectDir,
      sessionId: 's-1',
      agentId: 'a1',
    });
    for (const escape of [
      path.join('projects', '..', '..', 'other', 'projects', '-x', 's.jsonl'),
      path.join('..', 'other', 'projects', '-x', 's.jsonl'),
      path.join('projects', '..', 's.jsonl'),
      path.join('sessions', '2026', '09', '01', `rollout-2026-09-01T10-00-00-${UUID}.jsonl`),
      '',
    ]) {
      expect(
        classifyAgentTranscriptPath(escape, { env, baseDirs: [projectDir] }),
        escape,
      ).toBeNull();
    }
    // Without bases, and with invalid ones, a relative path stays unclassified.
    expect(classifyAgentTranscriptPath(relative, { env })).toBeNull();
    expect(classifyAgentTranscriptPath(relative, { env, baseDirs: ['relative', ''] })).toBeNull();
  });

  it('accepts the start folders as Claude homes for absolute paths with agentCwds', () => {
    const projectDir = path.join(root, 'work', 'app');
    const file = path.join(projectDir, 'projects', '-work-app', 's-2.jsonl');
    const env = { CLAUDE_CONFIG_DIR: '', HOME: root };
    expect(classifyAgentTranscriptPath(file, { env })).toBeNull();
    expect(classifyAgentTranscriptPath(file, { env, agentCwds: [projectDir] })).toEqual({
      provider: 'claude-code',
      kind: 'session',
      home: projectDir,
      sessionId: 's-2',
    });
    // The default home still classifies (older Claude Code treats '' as unset).
    expect(
      classifyAgentTranscriptPath(path.join(root, '.claude', 'projects', '-w', 's-3.jsonl'), {
        env,
        agentCwds: [projectDir],
      }),
    ).toMatchObject({ home: path.join(root, '.claude'), sessionId: 's-3' });
  });

  it('recognizes Claude Code sessions and subagent transcripts', () => {
    const project = path.join(claudeHome, 'projects', '-work-app');
    expect(
      classifyAgentTranscriptPath(path.join(project, 's-1.jsonl'), { homes: homes() }),
    ).toEqual({ provider: 'claude-code', kind: 'session', home: claudeHome, sessionId: 's-1' });
    expect(
      classifyAgentTranscriptPath(path.join(project, 's-1', 'subagents', 'agent-a1b2.jsonl'), {
        homes: homes(),
      }),
    ).toEqual({
      provider: 'claude-code',
      kind: 'subagent',
      home: claudeHome,
      sessionId: 's-1',
      agentId: 'a1b2',
    });
  });

  it('recognizes live, archived and compressed Codex rollouts', () => {
    const name = `rollout-2026-09-01T10-00-00-${UUID}.jsonl`;
    expect(
      classifyAgentTranscriptPath(path.join(codexHome, 'sessions', '2026', '09', '01', name), {
        homes: homes(),
      }),
    ).toEqual({
      provider: 'codex',
      kind: 'rollout',
      home: codexHome,
      sessionId: UUID,
      archived: false,
      compressed: false,
    });
    expect(
      classifyAgentTranscriptPath(path.join(codexHome, 'archived_sessions', `${name}.zst`), {
        homes: homes(),
      }),
    ).toMatchObject({ kind: 'rollout', sessionId: UUID, archived: true, compressed: true });
  });

  it('rejects paths outside the homes, wrong shapes and relative paths', () => {
    const project = path.join(claudeHome, 'projects', '-work-app');
    for (const candidate of [
      path.join(root, 'elsewhere', 's.jsonl'),
      path.join(project, 'notes.txt'),
      path.join(project, 's-1', 'subagents', 'agent-a1b2.meta.json'),
      path.join(project, 's-1', 'subagents', 'agent-../x.jsonl'),
      path.join(claudeHome, 'projects', 's.jsonl'),
      path.join(codexHome, 'sessions', '2026', 'notes.jsonl'),
      path.join(project, '..', '..', '..', 'escape.jsonl'),
      'relative/s.jsonl',
    ]) {
      expect(classifyAgentTranscriptPath(candidate, { homes: homes() }), candidate).toBeNull();
    }
  });

  it('never throws: invalid explicit homes are skipped, defaults come from env', () => {
    const file = path.join(root, 'from-env', 'projects', '-x', 's.jsonl');
    expect(() =>
      classifyAgentTranscriptPath(file, { homes: { claudeHomes: ['relative', ''] } }),
    ).not.toThrow();
    expect(
      classifyAgentTranscriptPath(file, {
        env: { CLAUDE_CONFIG_DIR: path.join(root, 'from-env'), HOME: root },
      }),
    ).toMatchObject({ provider: 'claude-code', kind: 'session', sessionId: 's' });
    expect(classifyAgentTranscriptPath(undefined as unknown as string)).toBeNull();
  });

  it('compares realpaths on request', () => {
    const project = path.join(claudeHome, 'projects', '-work-app');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 's.jsonl'), '{}\n');
    const linkedHome = path.join(root, 'linked-claude');
    fs.symlinkSync(claudeHome, linkedHome, 'dir');
    const viaLink = path.join(linkedHome, 'projects', '-work-app', 's.jsonl');
    expect(classifyAgentTranscriptPath(viaLink, { homes: homes() })).toBeNull();
    expect(classifyAgentTranscriptPath(viaLink, { homes: homes(), realpath: true })).toMatchObject({
      kind: 'session',
      sessionId: 's',
      home: claudeHome,
    });
  });
});

describe('readAgentVersion', () => {
  function write(name: string, rows: unknown[]): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return file;
  }

  it('reads the first and latest Claude Code version from the head and tail', () => {
    const rows = [
      { type: 'user', version: '2.1.0', entrypoint: 'cli', message: { content: 'x' } },
      ...Array.from({ length: 200 }, () => ({ type: 'system', content: 'f'.repeat(100) })),
      {
        type: 'user',
        version: '2.2.1',
        entrypoint: 'sdk-ts',
        // A tool result that carries its own "version" must not count.
        message: { content: [{ type: 'tool_result', content: '{"version":"9.9.9"}' }] },
      },
    ];
    const file = write('claude.jsonl', rows);
    expect(readAgentVersion(file, { windowBytes: 1024 })).toEqual({
      provider: 'claude-code',
      version: '2.2.1',
      firstVersion: '2.1.0',
      originator: 'sdk-ts',
    });
    expect(readAgentVersion(write('one.jsonl', [rows[0]]))).toEqual({
      provider: 'claude-code',
      version: '2.1.0',
      originator: 'cli',
    });
  });

  it("reads Codex's cli_version and originator from session_meta, even past the window", () => {
    const meta = (extra: Record<string, unknown> = {}) => ({
      timestamp: '2026-09-01T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: UUID,
        cwd: '/w',
        originator: 'codex_vscode',
        cli_version: '0.166.0',
        ...extra,
      },
    });
    const name = `rollout-2026-09-01T10-00-00-${UUID}.jsonl`;
    expect(readAgentVersion(write(name, [meta(), { type: 'turn_context' }]))).toEqual({
      provider: 'codex',
      version: '0.166.0',
      originator: 'codex_vscode',
    });
    const huge = write(`rollout-2026-09-01T10-00-01-${UUID}.jsonl`, [
      meta({ instructions: 'i'.repeat(200_000) }),
    ]);
    expect(readAgentVersion(huge, { windowBytes: 4096 })).toMatchObject({
      provider: 'codex',
      version: '0.166.0',
    });
  });

  it('gives null for compressed, missing, empty and unrecognized files', () => {
    expect(readAgentVersion(path.join(root, `rollout-x-${UUID}.jsonl.zst`))).toBeNull();
    expect(readAgentVersion(path.join(root, 'missing.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(root, 'empty.jsonl'), '');
    expect(readAgentVersion(path.join(root, 'empty.jsonl'))).toBeNull();
    fs.writeFileSync(path.join(root, 'junk.jsonl'), 'not json\n');
    expect(readAgentVersion(path.join(root, 'junk.jsonl'))).toBeNull();
    expect(
      readAgentVersion(write(`rollout-x-${UUID}.jsonl`, [{ type: 'response_item' }])),
    ).toBeNull();
  });

  it.skipIf(fs.constants.O_NOFOLLOW === undefined)(
    'refuses a symbolic link with noFollow, and follows it by default',
    () => {
      const target = write('target.jsonl', [{ type: 'user', version: '2.1.0' }]);
      const link = path.join(root, 'link.jsonl');
      fs.symlinkSync(target, link);
      expect(readAgentVersion(link)).toMatchObject({ version: '2.1.0' });
      expect(readAgentVersion(link, { noFollow: true })).toBeNull();
      expect(readAgentVersion(target, { noFollow: true })).toMatchObject({ version: '2.1.0' });
    },
  );
});

describe('readAgentModel', () => {
  function write(name: string, rows: unknown[]): string {
    const file = path.join(root, name);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return file;
  }
  const assistant = (model: string) => ({
    type: 'assistant',
    message: { model, role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  });
  const filler = Array.from({ length: 200 }, () => ({ type: 'system', content: 'f'.repeat(100) }));

  it('reads the latest Claude Code model from the tail, skipping <synthetic>', () => {
    const file = write('claude.jsonl', [
      assistant('claude-sonnet-5-5'),
      ...filler,
      assistant('claude-opus-5-5'),
      // A user line that quotes a model is not an assistant record.
      { type: 'user', message: { content: '"model":"assistant-x"' } },
      assistant('<synthetic>'),
    ]);
    expect(readAgentModel(file, { windowBytes: 1024 })).toEqual({
      provider: 'claude-code',
      model: 'claude-opus-5-5',
    });
  });

  it('falls back to the head when the tail names no model', () => {
    const file = write('head.jsonl', [assistant('claude-haiku-5-5'), ...filler]);
    expect(readAgentModel(file, { windowBytes: 1024 })).toEqual({
      provider: 'claude-code',
      model: 'claude-haiku-5-5',
    });
    expect(readAgentModel(write('small.jsonl', [assistant('claude-fable-5-2')]))).toEqual({
      provider: 'claude-code',
      model: 'claude-fable-5-2',
    });
  });

  it('reads the latest Codex turn_context model, past a long session_meta', () => {
    const turn = (model: string) => ({ type: 'turn_context', payload: { cwd: '/w', model } });
    const file = write(`rollout-2026-09-01T10-00-00-${UUID}.jsonl`, [
      { type: 'session_meta', payload: { id: UUID, instructions: 'i'.repeat(50_000) } },
      turn('gpt-6-luna'),
      ...filler,
      turn('gpt-6.1-sol'),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    ]);
    expect(readAgentModel(file, { windowBytes: 4096 })).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-sol',
    });
  });

  it('gives null for compressed, missing, model-less and invalid files', () => {
    expect(readAgentModel(path.join(root, `rollout-x-${UUID}.jsonl.zst`))).toBeNull();
    expect(readAgentModel(path.join(root, 'missing.jsonl'))).toBeNull();
    expect(readAgentModel(write('none.jsonl', [{ type: 'user', version: '2.1.0' }]))).toBeNull();
    expect(readAgentModel(write('bad.jsonl', [assistant('has spaces in it')]))).toBeNull();
  });

  it.skipIf(fs.constants.O_NOFOLLOW === undefined)('refuses a symbolic link with noFollow', () => {
    const target = write('t.jsonl', [assistant('claude-opus-5-5')]);
    const link = path.join(root, 'l.jsonl');
    fs.symlinkSync(target, link);
    expect(readAgentModel(link)).toMatchObject({ model: 'claude-opus-5-5' });
    expect(readAgentModel(link, { noFollow: true })).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('readers given something other than a file', () => {
  it('return null for a FIFO without blocking, with or without noFollow', () => {
    const fifo = path.join(root, 'fifo.jsonl');
    execFileSync('mkfifo', [fifo]);
    expect(readAgentVersion(fifo)).toBeNull();
    expect(readAgentVersion(fifo, { noFollow: true })).toBeNull();
    expect(readAgentModel(fifo, { noFollow: true })).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('classifyAgentTranscriptPath with realpath', () => {
  it('classifies a relative transcript not written yet under a symlinked base', () => {
    const real = path.join(root, 'real-project');
    fs.mkdirSync(real, { recursive: true });
    const linked = path.join(root, 'linked-project');
    fs.symlinkSync(real, linked);
    const relative = path.join('projects', '-p', 'new.jsonl');
    const env = { CLAUDE_CONFIG_DIR: '', HOME: root };
    for (const realpath of [false, true]) {
      expect(
        classifyAgentTranscriptPath(relative, { env, baseDirs: [linked], realpath }),
      ).toMatchObject({ provider: 'claude-code', kind: 'session', sessionId: 'new' });
    }
  });
});
