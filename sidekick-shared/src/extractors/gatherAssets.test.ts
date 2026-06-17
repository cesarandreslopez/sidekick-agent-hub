import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readClaudeAssets } from './sources/claudeAssets';
import { readCodexAssets } from './sources/codexAssets';
import { gatherAssetsForCwd } from './gatherAssets';

// These readers resolve sessions under os.homedir(); point HOME at a sandbox.
let home: string;
let cwd: string;
let realFile: string;
const origHome = process.env.HOME;

const claudeSlug = (dir: string): string => dir.replace(/[/._]/g, '-');

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-home-'));
  process.env.HOME = home;

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-cwd-'));
  realFile = path.join(cwd, 'src.ts');
  fs.writeFileSync(realFile, '// hi');

  // ── Claude session for this exact cwd ──
  const claudeDir = path.join(home, '.claude', 'projects', claudeSlug(cwd));
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeLines = [
    { type: 'assistant', timestamp: '2026-06-17T10:00:00Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Docs https://claude.test\n```bash\nnpm test\n```' },
      { type: 'tool_use', name: 'Read', input: { file_path: realFile } },
      { type: 'tool_use', name: 'ExitPlanMode', input: { plan: '# Claude Plan\n- [ ] do it' } },
    ] } },
  ].map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(path.join(claudeDir, 'session.jsonl'), claudeLines);

  // ── Codex rollout for this exact cwd ──
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '06', '17');
  fs.mkdirSync(codexDir, { recursive: true });
  const codexLines = [
    { type: 'session_meta', timestamp: '2026-06-17T11:00:00Z', payload: { cwd, id: 'x' } },
    { type: 'response_item', timestamp: '2026-06-17T11:00:01Z', payload: { type: 'agent_message', message: 'see https://codex.test' } },
    { type: 'response_item', timestamp: '2026-06-17T11:00:02Z', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: `cat ${realFile}` }) } },
    { type: 'response_item', timestamp: '2026-06-17T11:00:03Z', payload: { type: 'item_completed', item: { type: 'Plan', text: '# Codex Plan\n- step' } } },
  ].map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(path.join(codexDir, 'rollout-2026-06-17T11-00-00-abc.jsonl'), codexLines);

  // ── Codex rollout for a DIFFERENT cwd (must NOT be picked up) ──
  const otherLines = [
    { type: 'session_meta', timestamp: '2026-06-17T12:00:00Z', payload: { cwd: '/somewhere/else', id: 'y' } },
    { type: 'response_item', timestamp: '2026-06-17T12:00:01Z', payload: { type: 'agent_message', message: 'https://WRONG.test' } },
  ].map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(path.join(codexDir, 'rollout-2026-06-17T12-00-00-def.jsonl'), otherLines);
});

afterAll(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('readClaudeAssets', () => {
  it('extracts urls, commands, paths, and plans from the exact cwd', () => {
    const a = readClaudeAssets(cwd);
    expect(a.hadSession).toBe(true);
    expect(a.urls.map((u) => u.text)).toEqual(['https://claude.test']);
    expect(a.commands.map((c) => c.text)).toEqual(['npm test']);
    expect(a.paths.map((p) => p.text)).toEqual([realFile]);
    expect(a.plans.map((p) => p.display)).toEqual(['Claude Plan']);
  });

  it('returns nothing for a cwd with no session dir', () => {
    const a = readClaudeAssets(path.join(cwd, 'no-such-sub'));
    expect(a.hadSession).toBe(false);
    expect(a.urls).toEqual([]);
  });
});

describe('readCodexAssets', () => {
  it('matches the exact cwd only and mines urls/paths/plans', () => {
    const a = readCodexAssets(cwd);
    expect(a.hadSession).toBe(true);
    expect(a.urls.map((u) => u.text)).toContain('https://codex.test');
    expect(a.urls.map((u) => u.text)).not.toContain('https://WRONG.test');
    expect(a.paths.map((p) => p.text)).toContain(realFile);
    expect(a.plans.map((p) => p.display)).toContain('Codex Plan');
  });

  it('does not pick up a different cwd', () => {
    const a = readCodexAssets('/somewhere/else');
    // The fixture for /somewhere/else has no real files; only its URL.
    expect(a.urls.map((u) => u.text)).toEqual(['https://WRONG.test']);
  });
});

describe('gatherAssetsForCwd', () => {
  it('merges both agents for the exact cwd, newest-first', () => {
    const a = gatherAssetsForCwd({ cwd });
    expect(a.inChat).toBe(true);
    // Codex (11:00) is newer than Claude (10:00), so its URL sorts first.
    expect(a.urls.map((u) => u.text)).toEqual(['https://codex.test', 'https://claude.test']);
    expect(a.commands.map((c) => c.text)).toEqual(['npm test']);
    expect(a.paths.map((p) => p.text)).toEqual([realFile]);
    expect(a.plans.map((p) => p.display).sort()).toEqual(['Claude Plan', 'Codex Plan']);
  });

  it('can scope to a single agent', () => {
    const a = gatherAssetsForCwd({ cwd, agents: ['claude'] });
    expect(a.urls.map((u) => u.text)).toEqual(['https://claude.test']);
  });

  it('respects caps', () => {
    const a = gatherAssetsForCwd({ cwd, caps: { url: 1 } });
    expect(a.urls).toHaveLength(1);
  });
});
