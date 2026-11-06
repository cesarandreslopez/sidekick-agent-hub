import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyAgentTranscriptPath, readAgentVersion } from './agentPaths';

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
});
