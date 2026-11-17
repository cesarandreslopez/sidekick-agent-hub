/**
 * The demo session must read back through the real parsers the way the clips
 * rely on. If Claude Code's session format or Sidekick's readers change, this
 * fails before a re-record silently shows an empty dashboard.
 *
 *   node --test generate.test.mjs     (needs a built sidekick-cli)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { buildSandbox } from './lib/generate.mjs';
import { Feeder } from './lib/feeder.mjs';
import { CLI_BIN, sandboxEnv } from './lib/sandbox.mjs';

const { paths, live, files } = buildSandbox();
await new Feeder({ files, entries: live, speed: 1_000, maxGapMs: 0 }).play();

function sidekick(args) {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args, '--project', paths.project], {
    cwd: paths.project,
    env: sandboxEnv(paths),
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `sidekick ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

test('the session parses with its tools, models, subagent and tokens', () => {
  const dump = JSON.parse(sidekick(['dump', '--format', 'json']));
  assert.equal(dump.providerId, 'claude-code');
  assert.equal(dump.currentModel, 'claude-opus-5-5');
  const tools = Object.fromEntries(dump.toolStats.map((t) => [t.name, t]));
  for (const name of ['Read', 'Edit', 'Bash', 'Write', 'TodoWrite', 'Agent', 'WebFetch', 'Skill', 'mcp__github__create_pull_request']) {
    assert.ok(tools[name], `tool ${name} missing from toolStats`);
  }
  assert.ok(tools.Bash.failureCount >= 2, 'the failing tests and the denial should count as Bash failures');
  assert.equal(dump.subagents.length, 1);
  assert.equal(dump.subagents[0].subagentType, 'Explore');
  assert.ok(dump.tokens.totalTokens > 1_000_000, 'cache-inclusive total should be in the millions');
  assert.ok(dump.tokens.cacheReadTokens > dump.tokens.cacheWriteTokens * 10, 'cache reads should dominate, as in real sessions');
});

test('the activity map sees the stations and faults the clips show', () => {
  // Patterns (edit ↔ test loops) depend on real pacing, which the takes have and this test does not.
  const map = JSON.parse(sidekick(['map', '--format', 'json']));
  const busy = map.insights.stations.filter((s) => s.calls > 0);
  const ids = new Set(busy.map((s) => s.id));
  for (const s of ['shell', 'files', 'network', 'agents', 'plan', 'skills']) assert.ok(ids.has(s), `station ${s} has no calls (busy: ${[...ids].join(', ')})`);
  const shell = busy.find((s) => s.id === 'shell');
  assert.ok(shell.errors >= 1, 'the failing test runs should show as Shell errors');
  assert.ok(busy.some((s) => s.denials >= 1), 'the declined cache clear should show as a denial');
});

test('history and usage reports have earlier days', () => {
  const daily = JSON.parse(sidekick(['--json', 'daily']));
  const rows = Array.isArray(daily) ? daily : (daily.rows ?? daily.days ?? []);
  assert.ok(rows.length >= 8, `expected at least 8 days of usage, got ${rows.length}`);
});

test('nothing in the sandbox names the real machine', () => {
  const text = readFileSync(files.main, 'utf8');
  assert.ok(!text.includes(os.homedir()), 'session file contains the real home folder');
  assert.ok(!text.toLowerCase().includes(os.userInfo().username.toLowerCase()), 'session file contains the real username');
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9-]+\.)+[A-Z]{2,}/gi)) {
    assert.match(match[0], /@example\.com$/i, `unexpected email ${match[0]}`);
  }
});
