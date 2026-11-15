import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeClaudeWorkspacePath } from '../claudePaths';
import { readClaudeCodePlanFiles } from './plans';

describe('readClaudeCodePlanFiles', () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-plans-'));
    previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeSession(workspace: string, sessionId: string, slug: string): void {
    const dir = path.join(home, 'projects', encodeClaudeWorkspacePath(path.resolve(workspace)));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', slug, sessionId })}\n`,
    );
  }

  function writePlan(slug: string, markdown: string): void {
    const dir = path.join(home, 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.md`), markdown);
  }

  it('lists every session that references a plan slug', async () => {
    const workspace = path.join(home, 'work', 'repo');
    writeSession(workspace, 'aaaa1111-0000-0000-0000-000000000000', 'brave-otter');
    writeSession(workspace, 'bbbb2222-0000-0000-0000-000000000000', 'brave-otter');
    writePlan('brave-otter', '# Ship it\n\n- [ ] step one\n');

    const plans = await readClaudeCodePlanFiles(workspace);
    expect(plans).toHaveLength(1);
    // sessionId keeps its meaning (the slug) for existing consumers.
    expect(plans[0].sessionId).toBe('brave-otter');
    expect(plans[0].sessionIds).toEqual([
      'aaaa1111-0000-0000-0000-000000000000',
      'bbbb2222-0000-0000-0000-000000000000',
    ]);
  });

  it("finds plans for workspaces whose path has dots or spaces (Claude Code's encoding)", async () => {
    const workspace = path.join(home, 'my.project dir');
    writeSession(workspace, 'cccc3333-0000-0000-0000-000000000000', 'calm-heron');
    writePlan('calm-heron', '# Plan\n');

    const plans = await readClaudeCodePlanFiles(workspace);
    expect(plans.map((p) => p.id)).toEqual(['claude-plan-calm-heron']);
  });
});
