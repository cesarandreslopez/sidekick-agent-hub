import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherAssetsForCwd } from './gatherAssets';
import { readClaudeAssets } from './sources/claudeAssets';
import { readCodexAssets } from './sources/codexAssets';

let home: string;
let explicitCodexHome: string;
let cwd: string;
let childCwd: string;
let realFile: string;
let mentionedFile: string;
let claudeSessionPath: string;
let codexSessionPath: string;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

const claudeSlug = (dir: string): string => dir.replace(/[/._]/g, '-');

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-home-'));
  explicitCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-codex-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-cwd-'));
  childCwd = path.join(cwd, 'child');
  fs.mkdirSync(childCwd);

  realFile = path.join(cwd, 'src.ts');
  mentionedFile = path.join(cwd, 'mentioned.ts');
  fs.writeFileSync(realFile, '// real');
  fs.writeFileSync(mentionedFile, '// mentioned');

  process.env.HOME = home;
  process.env.CODEX_HOME = explicitCodexHome;

  claudeSessionPath = path.join(home, '.claude', 'projects', claudeSlug(cwd), 'session.jsonl');
  codexSessionPath = path.join(explicitCodexHome, 'sessions', '2026', '06', '17', 'rollout-codex.jsonl');

  writeJsonl(claudeSessionPath, [
    {
      type: 'assistant',
      timestamp: '2026-06-17T10:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Docs https://claude.test\nOpen ${mentionedFile}:7\n\`\`\`bash\nnpm test\n\`\`\`` },
          { type: 'tool_use', name: 'Read', input: { file_path: realFile } },
          { type: 'tool_use', name: 'ExitPlanMode', input: { plan: '# Claude Plan\n- [ ] do it' } },
        ],
      },
    },
  ]);

  writeJsonl(path.join(home, '.claude', 'projects', claudeSlug(childCwd), 'child.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-06-17T10:30:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'https://child-only.test' }] },
    },
  ]);

  writeJsonl(codexSessionPath, [
    { type: 'session_meta', timestamp: '2026-06-17T11:00:00Z', payload: { cwd, id: 'x' } },
    { type: 'response_item', timestamp: '2026-06-17T11:00:01Z', payload: { type: 'agent_message', message: `see https://codex.test and ${mentionedFile}:12` } },
    { type: 'response_item', timestamp: '2026-06-17T11:00:02Z', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: `cat ${realFile}` }) } },
    { type: 'response_item', timestamp: '2026-06-17T11:00:03Z', payload: { type: 'item_completed', item: { type: 'Plan', text: '# Codex Plan\n- step' } } },
  ]);

  writeJsonl(path.join(explicitCodexHome, 'sessions', '2026', '06', '17', 'rollout-child.jsonl'), [
    { type: 'session_meta', timestamp: '2026-06-17T12:00:00Z', payload: { cwd: childCwd, id: 'y' } },
    { type: 'response_item', timestamp: '2026-06-17T12:00:01Z', payload: { type: 'agent_message', message: 'https://codex-child-only.test' } },
  ]);
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(explicitCodexHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('readClaudeAssets', () => {
  it('extracts URLs, commands, paths from tool input and message text, and plans for the exact cwd', () => {
    const assets = readClaudeAssets(cwd);

    expect(assets.hadSession).toBe(true);
    expect(assets.urls.map((u) => u.text)).toEqual(['https://claude.test']);
    expect(assets.commands.map((c) => c.text)).toEqual(['npm test']);
    expect(assets.paths.map((p) => p.text)).toEqual([`${mentionedFile}:7`, realFile]);
    expect(assets.plans.map((p) => p.display)).toEqual(['Claude Plan']);
    expect(assets.urls[0]).toMatchObject({
      agent: 'claude',
      sessionPath: claudeSessionPath,
      source: 'message',
    });
    expect(assets.paths[1]).toMatchObject({
      agent: 'claude',
      sessionPath: claudeSessionPath,
      source: 'tool:Read',
    });
    expect(assets.plans[0]).toMatchObject({
      agent: 'claude',
      sessionPath: claudeSessionPath,
      source: 'tool:ExitPlanMode',
    });
  });

  it('does not read parent or child sessions when scoped to a cwd', () => {
    const assets = readClaudeAssets(cwd);

    expect(assets.urls.map((u) => u.text)).not.toContain('https://child-only.test');
  });
});

describe('readCodexAssets', () => {
  it('reads Codex rollouts from CODEX_HOME and extracts message-text paths', () => {
    const assets = readCodexAssets(cwd);

    expect(assets.hadSession).toBe(true);
    expect(assets.urls.map((u) => u.text)).toContain('https://codex.test');
    expect(assets.urls.map((u) => u.text)).not.toContain('https://codex-child-only.test');
    expect(assets.paths.map((p) => p.text)).toContain(`${mentionedFile}:12`);
    expect(assets.paths.map((p) => p.text)).toContain(realFile);
    expect(assets.plans.map((p) => p.display)).toContain('Codex Plan');
    expect(assets.urls.find((u) => u.text === 'https://codex.test')).toMatchObject({
      agent: 'codex',
      sessionPath: codexSessionPath,
      source: 'message',
    });
    expect(assets.paths.find((p) => p.text === realFile)).toMatchObject({
      agent: 'codex',
      sessionPath: codexSessionPath,
      source: 'tool:shell',
    });
    expect(assets.plans.find((p) => p.display === 'Codex Plan')).toMatchObject({
      agent: 'codex',
      sessionPath: codexSessionPath,
      source: 'plan',
    });
  });
});

describe('gatherAssetsForCwd', () => {
  it('merges both supported agents newest-first with caps and exact-cwd isolation', () => {
    const assets = gatherAssetsForCwd({ cwd, caps: { url: 1 } });

    expect(assets.inChat).toBe(true);
    expect(assets.urls.map((u) => u.text)).toEqual(['https://codex.test']);
    expect(assets.commands.map((c) => c.text)).toEqual(['npm test']);
    expect(assets.plans.map((p) => p.display).sort()).toEqual(['Claude Plan', 'Codex Plan']);
    expect(assets.urls[0]).toMatchObject({ agent: 'codex', sessionPath: codexSessionPath });
    expect(assets.commands[0]).toMatchObject({ agent: 'claude', sessionPath: claudeSessionPath });
  });

  it('can scope extraction to one agent', () => {
    const assets = gatherAssetsForCwd({ cwd, agents: ['claude'] });

    expect(assets.urls.map((u) => u.text)).toEqual(['https://claude.test']);
  });
});
