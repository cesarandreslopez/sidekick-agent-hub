/**
 * Turns the demo scenario into Claude Code session files.
 *
 * buildTimeline() lays the scenario out at its recorded pace: every JSONL line
 * with its offset from the session start, the file it belongs to (the main
 * transcript or a subagent's), and whether the feeder appends it live. Usage
 * numbers follow the shape of real sessions: a large first cache write, then
 * cache reads that grow with the context and small writes for each new result.
 *
 * writePreRoll() writes the turns that are already done when a take starts,
 * anchored so they end just before "now". writeHistory() adds smaller backdated
 * sessions so charts, billing blocks and the history views have something to show.
 *
 * Run directly (`node lib/generate.mjs`) to build a fresh sandbox with the
 * pre-roll, the history and the project stores, without recording anything.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scenario as defaultScenario, historyPrompts } from '../scenario/storefront.mjs';
import { prepareSandbox, sandboxEnv, claudeSessionDir, encodeClaudeProjectDir, CLI_BIN } from './sandbox.mjs';

/** Deterministic PRNG so every take generates the same session. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tokensOf = (text) => Math.max(1, Math.round(String(text ?? '').length / 3.6));
const between = (rand, lo, hi) => Math.round(lo + rand() * (hi - lo));

/** A uuid-shaped id from the PRNG (stable across runs). */
function makeUuid(rand) {
  const hex = () => Math.floor(rand() * 16).toString(16);
  const part = (n) => Array.from({ length: n }, hex).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-${'89ab'[Math.floor(rand() * 4)]}${part(3)}-${part(12)}`;
}

/**
 * Lay the scenario out. Returns { sessionId, cwd, entries, agents } where each
 * entry is { at, target, line, live, toolUseId?, phase? }; `line.timestamp` is
 * filled in when the line is written.
 */
export function buildTimeline({ scenario = defaultScenario, cwd, seed = 7 } = {}) {
  const rand = prng(seed);
  const entries = [];
  const agents = [];
  const common = {
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: scenario.sessionId,
    version: scenario.ccVersion,
    gitBranch: scenario.branch,
  };
  const abs = (p) => (p && !p.startsWith('/') ? join(cwd, p) : p);
  const absInput = (input) => {
    const out = { ...input };
    if (out.file_path) out.file_path = abs(out.file_path);
    if (out.path) out.path = abs(out.path);
    return out;
  };

  let at = 0;
  let parentUuid = null;
  let msgN = 0;
  let toolN = 0;
  // Context accounting for the main thread.
  let cached = 0;
  let pending = 0; // tokens added since the last API call
  let firstCall = true;
  let live = false;

  const push = (target, line, extra = {}) => {
    const uuid = makeUuid(rand);
    const full = target === 'main' ? { parentUuid, isSidechain: false, ...line, uuid, ...common } : line;
    if (target === 'main') parentUuid = uuid;
    entries.push({ at, target, line: full, live, ...extra });
    return full;
  };

  /** Usage for one API call on the main thread. */
  const usageFor = (outputTokens) => {
    let cacheRead;
    let cacheWrite;
    if (firstCall) {
      // Claude Code's system prompt and tool list are usually cached from an earlier session.
      cacheRead = 31_200;
      cacheWrite = scenario.baseContextTokens - 31_200 + pending;
      firstCall = false;
    } else {
      cacheRead = cached;
      cacheWrite = pending;
    }
    cached = cacheRead + cacheWrite;
    pending = outputTokens; // this call's output is part of the next call's prompt
    return {
      input_tokens: between(rand, 2, 6),
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      output_tokens: outputTokens,
      cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
      service_tier: 'standard',
    };
  };

  /** One API message, written as one line per content block like Claude Code does. */
  const assistant = (blocks, { stop, outputTokens, model = scenario.model, phase, toolUseId }) => {
    const id = `msg_01${String(++msgN).padStart(4, '0')}${makeUuid(rand).slice(0, 12).replace(/-/g, '')}`;
    const requestId = `req_011C${makeUuid(rand).replace(/-/g, '').slice(0, 20)}`;
    const usage = usageFor(outputTokens);
    for (const block of blocks) {
      push(
        'main',
        {
          type: 'assistant',
          requestId,
          message: { model, id, type: 'message', role: 'assistant', content: [block], stop_reason: stop, stop_sequence: null, usage },
        },
        { phase, toolUseId },
      );
      at += 40;
    }
  };

  for (const turn of scenario.turns) {
    live = Boolean(turn.live);
    at += live ? 2_500 : between(rand, 20_000, 45_000);
    const promptId = makeUuid(rand);
    push(
      'main',
      { type: 'user', promptId, message: { role: 'user', content: turn.prompt }, permissionMode: 'default', origin: { kind: 'human' }, promptSource: 'typed' },
      { phase: 'prompt' },
    );
    pending += tokensOf(turn.prompt);
    const turnStart = at;
    let messages = 1;
    if (turn.memory) {
      at += 300;
      push('main', {
        type: 'attachment',
        attachment: { type: 'nested_memory', path: abs(turn.memory.path), displayPath: turn.memory.path, content: { path: abs(turn.memory.path), type: 'Project', content: '# storefront\n\nTypeScript, Express 5, Vitest. Run `npm test` before committing.' } },
      });
      pending += turn.memory.tokens;
    }

    for (const step of turn.steps) {
      const toolUseId = `toolu_01${makeUuid(rand).replace(/-/g, '').slice(0, 22)}`;
      const outputTokens = step.output ?? tokensOf(JSON.stringify(step.input)) + tokensOf(step.say) + between(rand, 60, 380);
      at += 900 + outputTokens * between(rand, 8, 14);
      const blocks = [];
      if (step.say) blocks.push({ type: 'text', text: step.say });
      blocks.push({ type: 'tool_use', id: toolUseId, name: step.tool, input: absInput(step.input) });
      assistant(blocks, { stop: 'tool_use', outputTokens, phase: 'tool_use', toolUseId });
      messages += blocks.length;
      const callAt = at;

      if (step.hook) {
        at += step.hook.ms;
        push('main', {
          type: 'attachment',
          attachment: { type: 'hook_success', hookName: step.hook.name, toolUseID: toolUseId, hookEvent: 'PreToolUse', content: '', stdout: '', stderr: '', exitCode: 0, command: step.hook.command, durationMs: step.hook.ms },
        });
      }

      if (step.agent) {
        const agent = step.agent;
        agents.push({ id: agent.id, meta: { agentType: agent.type, description: step.input.description, toolUseId } });
        let subAt = callAt + 400;
        let subCached = 0;
        let subPending = 11_800 + tokensOf(step.input.prompt);
        const subCommon = { ...common, isSidechain: true, agentId: agent.id };
        const sub = (line) => {
          entries.push({ at: subAt, target: agent.id, line: { ...line, ...subCommon, uuid: makeUuid(rand) }, live });
        };
        sub({ type: 'user', message: { role: 'user', content: step.input.prompt } });
        const subCall = (content, stop, out) => {
          const usage = {
            input_tokens: between(rand, 2, 6),
            cache_creation_input_tokens: subPending,
            cache_read_input_tokens: subCached,
            output_tokens: out,
            service_tier: 'standard',
          };
          subCached += subPending;
          subPending = out;
          subAt += 700 + out * 6;
          sub({ type: 'assistant', requestId: `req_011C${makeUuid(rand).replace(/-/g, '').slice(0, 20)}`, message: { model: agent.model, id: `msg_01s${makeUuid(rand).slice(0, 13).replace(/-/g, '')}`, type: 'message', role: 'assistant', content, stop_reason: stop, usage } });
        };
        for (const s of agent.steps) {
          const id = `toolu_01${makeUuid(rand).replace(/-/g, '').slice(0, 22)}`;
          subCall([{ type: 'tool_use', id, name: s.tool, input: absInput(s.input) }], 'tool_use', between(rand, 40, 160));
          subAt += s.ms;
          sub({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: s.result }] } });
          subPending += s.tokens ?? tokensOf(s.result);
        }
        subCall([{ type: 'text', text: agent.report }], 'end_turn', tokensOf(agent.report) + 80);
        at = Math.max(callAt + step.ms, subAt + 300);
      } else {
        at = callAt + (step.ms ?? 100);
      }

      const result = { type: 'tool_result', tool_use_id: toolUseId, content: step.result };
      if (step.error || step.denied) result.is_error = true;
      push('main', { type: 'user', message: { role: 'user', content: [result] }, permissionMode: 'default' }, { phase: 'tool_result', toolUseId });
      messages += 1;
      pending += step.tokens ?? tokensOf(step.result);
      toolN += 1;
    }

    const replyTokens = tokensOf(turn.reply) + between(rand, 120, 420);
    at += 900 + replyTokens * 10;
    assistant([{ type: 'text', text: turn.reply }], { stop: 'end_turn', outputTokens: replyTokens, phase: 'reply' });
    messages += 1;
    at += 120;
    push('main', { type: 'system', subtype: 'turn_duration', durationMs: at - turnStart, messageCount: messages, isMeta: false });
  }

  return { sessionId: scenario.sessionId, cwd, entries, agents, toolCalls: toolN };
}

/** Where each target's lines go. */
export function targetFiles(sessionDir, timeline) {
  const files = { main: join(sessionDir, `${timeline.sessionId}.jsonl`) };
  for (const agent of timeline.agents) {
    files[agent.id] = join(sessionDir, timeline.sessionId, 'subagents', `agent-${agent.id}.jsonl`);
  }
  return files;
}

/** Serialise an entry with its wall-clock timestamp. */
export function lineAt(entry, timestampMs) {
  return `${JSON.stringify({ ...entry.line, timestamp: new Date(timestampMs).toISOString() })}\n`;
}

/**
 * Write the turns that happened before the take, ending `gapMs` before `now`.
 * Returns the files and the live entries left for the feeder.
 */
export function writePreRoll(paths, timeline, { now = Date.now(), gapMs = 75_000 } = {}) {
  const sessionDir = claudeSessionDir(paths);
  const files = targetFiles(sessionDir, timeline);
  mkdirSync(sessionDir, { recursive: true });
  for (const agent of timeline.agents) {
    const dir = join(sessionDir, timeline.sessionId, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-${agent.id}.meta.json`), JSON.stringify(agent.meta));
  }
  const pre = timeline.entries.filter((e) => !e.live);
  const lastAt = pre.length ? Math.max(...pre.map((e) => e.at)) : 0;
  const anchor = now - gapMs - lastAt;
  const chunks = {};
  for (const entry of pre) chunks[entry.target] = (chunks[entry.target] ?? '') + lineAt(entry, anchor + entry.at);
  for (const [target, file] of Object.entries(files)) {
    writeFileSync(file, chunks[target] ?? '');
    const last = pre.filter((e) => e.target === target).at(-1);
    if (last) utimesSync(file, new Date(anchor + last.at), new Date(anchor + last.at));
  }
  return { files, live: timeline.entries.filter((e) => e.live) };
}

/**
 * Smaller backdated sessions over the last `days` days, in this project and a
 * sibling one, so history, charts and billing blocks are populated.
 */
export function writeHistory(paths, { now = Date.now(), days = 18, seed = 11, model = 'claude-opus-5-5' } = {}) {
  const rand = prng(seed);
  const projects = [paths.project, join(paths.home, 'billing')];
  let written = 0;
  for (let d = days; d >= 1; d--) {
    const day = new Date(now - d * 86_400_000);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const sessions = weekend ? (rand() < 0.3 ? 1 : 0) : between(rand, 1, 3);
    for (let s = 0; s < sessions; s++) {
      const project = rand() < 0.75 ? projects[0] : projects[1];
      mkdirSync(project, { recursive: true });
      const start = new Date(day);
      start.setHours(between(rand, 9, 18), between(rand, 0, 59), between(rand, 0, 59), 0);
      const sessionId = makeUuid(rand);
      const sessionModel = rand() < 0.2 ? 'claude-sonnet-5-5' : model;
      const lines = [];
      let t = start.getTime();
      let cached = 15_200;
      let parent = null;
      const base = { userType: 'external', entrypoint: 'cli', cwd: project, sessionId, version: defaultScenario.ccVersion, gitBranch: 'main' };
      const line = (obj) => {
        const uuid = makeUuid(rand);
        lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, ...obj, uuid, timestamp: new Date(t).toISOString(), ...base }));
        parent = uuid;
      };
      const prompt = historyPrompts[Math.floor(rand() * historyPrompts.length)];
      line({ type: 'user', promptId: makeUuid(rand), message: { role: 'user', content: prompt }, permissionMode: 'default', origin: { kind: 'human' }, promptSource: 'typed' });
      const calls = between(rand, 6, 28);
      let pending = 9_400 + tokensOf(prompt);
      for (let c = 0; c < calls; c++) {
        const tool = ['Read', 'Read', 'Edit', 'Bash', 'Grep', 'Edit', 'Read'][Math.floor(rand() * 7)];
        const out = between(rand, 90, 900);
        t += between(rand, 2_000, 14_000);
        const id = `toolu_01${makeUuid(rand).replace(/-/g, '').slice(0, 22)}`;
        const input = tool === 'Bash' ? { command: 'npm test', description: 'Run tests' } : tool === 'Grep' ? { pattern: 'TODO', path: join(project, 'src') } : { file_path: join(project, 'src', `module${c % 9}.ts`) };
        line({ type: 'assistant', requestId: `req_011C${makeUuid(rand).replace(/-/g, '').slice(0, 20)}`, message: { model: sessionModel, id: `msg_01h${makeUuid(rand).slice(0, 13).replace(/-/g, '')}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }], stop_reason: 'tool_use', usage: { input_tokens: between(rand, 2, 6), cache_creation_input_tokens: pending, cache_read_input_tokens: cached, output_tokens: out, service_tier: 'standard' } } });
        cached += pending;
        t += between(rand, 80, tool === 'Bash' ? 12_000 : 600);
        const fail = tool === 'Bash' && rand() < 0.25;
        const resultTokens = between(rand, 200, 3_200);
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: fail ? 'Exit code 1\n1 failed' : 'ok', ...(fail ? { is_error: true } : {}) }] } });
        pending = out + resultTokens;
      }
      t += between(rand, 3_000, 9_000);
      line({ type: 'assistant', requestId: `req_011C${makeUuid(rand).replace(/-/g, '').slice(0, 20)}`, message: { model: sessionModel, id: `msg_01h${makeUuid(rand).slice(0, 13).replace(/-/g, '')}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 3, cache_creation_input_tokens: pending, cache_read_input_tokens: cached, output_tokens: between(rand, 120, 500), service_tier: 'standard' } } });
      const dir = join(paths.claudeHome, 'projects', encodeClaudeProjectDir(project.replace(/^\/tmp\//, '/private/tmp/')));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sessionId}.jsonl`);
      writeFileSync(file, `${lines.join('\n')}\n`);
      // A finished session's file was last written when it ended; Sidekick treats fresh mtimes as live.
      utimesSync(file, new Date(t), new Date(t));
      written += 1;
    }
  }
  return written;
}

/** Run the CLI inside the sandbox (for seeding stores). */
export function sidekick(paths, args) {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args, '--project', paths.project], {
    cwd: paths.project,
    env: sandboxEnv(paths),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(`sidekick ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Tasks, decisions and notes for the Kanban, Decisions and Notes panels. */
export function seedProjectStores(paths) {
  sidekick(paths, ['tasks', 'add', 'Load-test checkout at 4 instances', '--tags', 'perf']);
  sidekick(paths, [
    'decision', 'add', 'Keep rate-limit counters in Redis',
    '--chosen', 'Fixed window with INCR + PEXPIRE in one MULTI',
    '--alternatives', 'In-memory sliding window,Token bucket in Postgres',
    '--tags', 'checkout,redis',
  ]);
  sidekick(paths, ['note', 'add', 'The checkout test client shares one API key; clear limiter state in beforeEach.', '--file', 'test/checkout.test.ts', '--type', 'gotcha', '--importance', 'high']);
  sidekick(paths, ['note', 'add', 'Retry-After is whole seconds, not milliseconds.', '--file', 'src/middleware/rateLimit.ts', '--type', 'guideline']);
}

/** Small source tree so editors and file views have real files to show. */
export function writeProjectFiles(paths) {
  const files = {
    'package.json': '{\n  "name": "storefront",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n',
    'CLAUDE.md': '# storefront\n\nTypeScript, Express 5, Vitest. Run `npm test` before committing.\n',
    'CHANGELOG.md': '# Changelog\n\n## Unreleased\n',
    'src/routes/checkout.ts': "import { Router } from 'express';\nimport { rateLimit } from '../middleware/rateLimit';\nimport { validateCart } from '../middleware/validateCart';\n\nexport const router = Router();\n\nrouter.post('/checkout', rateLimit({ limit: 20, windowMs: 60_000 }), validateCart, async (req, res) => {\n  res.status(201).json(await createOrder(req.apiKey, req.body.cart));\n});\n",
    'src/middleware/rateLimit.ts': "import type { RequestHandler } from 'express';\nimport { redis } from '../lib/redis';\n\nexport function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }): RequestHandler {\n  return async (req, res, next) => {\n    const window = Math.floor(Date.now() / windowMs);\n    const key = `rl:checkout:${req.apiKey}:${window}`;\n    const [[, count], [, ttlMs]] = await redis.multi().incr(key).pexpire(key, windowMs).pttl(key).exec();\n    if (Number(count) > limit) {\n      res.set('Retry-After', String(Math.ceil(ttlMs / 1000)));\n      return res.status(429).json({ error: 'rate_limited' });\n    }\n    next();\n  };\n}\n",
    'src/lib/redis.ts': "import Redis from 'ioredis';\nexport const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');\n",
    'test/checkout.test.ts': "import { describe, it, expect } from 'vitest';\n\ndescribe('POST /checkout', () => {\n  it('creates an order', () => {\n    expect(true).toBe(true);\n  });\n});\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const file = join(paths.project, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, body);
  }
}

/** Build a complete sandbox: files, history, pre-roll, stores and the history import. */
export function buildSandbox({ fresh = true, now = Date.now(), gapMs } = {}) {
  const paths = prepareSandbox({ fresh });
  writeProjectFiles(paths);
  const history = writeHistory(paths, { now });
  seedProjectStores(paths);
  // Import before the demo session exists, so the history store holds only past days.
  sidekick(paths, ['import']);
  const timeline = buildTimeline({ cwd: realCwd(paths) });
  const pre = writePreRoll(paths, timeline, { now, gapMs });
  return { paths, timeline, ...pre, history };
}

/** The cwd Claude Code would record: the resolved project path. */
export function realCwd(paths) {
  return paths.project.replace(/^\/tmp\//, '/private/tmp/');
}

export { appendFileSync };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { paths, timeline, live, history, files } = buildSandbox();
  console.log(`sandbox: ${paths.root}`);
  console.log(`session: ${files.main}`);
  console.log(`pre-roll lines: ${timeline.entries.length - live.length}, live lines: ${live.length}, tool calls: ${timeline.toolCalls}`);
  console.log(`history sessions: ${history}`);
}
