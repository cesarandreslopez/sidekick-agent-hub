/**
 * The demo session: a believable afternoon on `storefront`, a small TypeScript
 * shop API. Everything here is invented; nothing comes from a real session.
 *
 * Turns marked `live: true` are appended by the feeder while a take records, so
 * the dashboards move on camera. Earlier turns are already in the file when the
 * take starts (the pre-roll), ending a minute or two before "now".
 *
 * Step fields:
 *   say      assistant text written before the tool call (same API message)
 *   tool     tool name; `input` its input; `result` the tool result text
 *   tokens   tokens the result adds to the context (defaults to its length / 3.6)
 *   ms       how long the tool ran in the recorded session
 *   error    the tool failed (non-zero exit, failing test)
 *   denied   the user rejected the tool use
 *   hook     a PreToolUse hook that ran before the tool
 *   agent    a subagent the tool started (its own steps, model and id)
 */


/** Deterministic filler so file reads have realistic length (Claude Code returns whole files). */
function fillerLines(seed, count) {
  let a = seed >>> 0;
  const rand = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const nouns = ['order', 'cart', 'invoice', 'customer', 'refund', 'shipment', 'coupon', 'payment', 'product', 'session'];
  const verbs = ['load', 'save', 'find', 'apply', 'validate', 'build', 'resolve', 'record', 'compute', 'sync'];
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const out = [];
  while (out.length < count) {
    const n = pick(nouns);
    const v = pick(verbs);
    const N = cap(n);
    out.push(
      '',
      `export async function ${v}${N}(id: string, opts: ${N}Options = {}): Promise<${N}> {`,
      `  const row = await db.${n}s.findUnique({ where: { id } });`,
      `  if (!row) throw new NotFoundError('${n}', id);`,
      `  logger.debug({ id, op: '${v}' }, '${n} ${v}');`,
      `  return opts.raw ? row : to${N}(row);`,
      '}',
    );
  }
  return out.slice(0, count);
}

/** A Read tool result: the snippet first, padded to `lines`, numbered like Claude Code does. */
function read(snippet, lines, seed = lines) {
  const body = snippet.split('\n');
  const all = body.length >= lines ? body : [...body, ...fillerLines(seed, lines - body.length)];
  return all.map((line, i) => `${String(i + 1).padStart(6)}→${line}`).join('\n');
}

/** Vitest output with one line per test. */
function vitest(passed, failedName, total) {
  const names = ['creates an order', 'rejects an empty cart', 'applies a coupon', 'rejects an expired coupon', 'charges tax by region', 'handles a declined card', 'is idempotent per request id', 'reserves stock', 'releases stock on failure', 'emails a receipt', 'rejects a missing API key', 'limits each key separately', 'resets the window', 'answers 429 over the limit', 'sets Retry-After'];
  const lines = names.slice(0, Math.min(total, names.length)).map((n) => (n === failedName ? `   × POST /checkout > ${n}` : `   ✓ POST /checkout > ${n} ${3 + (n.length % 9)}ms`));
  return lines.join('\n');
}

const CODE = {
  checkout: `import { Router } from 'express';
import { validateCart } from '../middleware/validateCart';
import { createOrder } from '../services/orders';

export const router = Router();

router.post('/checkout', validateCart, async (req, res) => {
  const order = await createOrder(req.apiKey, req.body.cart);
  res.status(201).json(order);
});`,
  middleware: `export { requireApiKey } from './requireApiKey';
export { validateCart } from './validateCart';
export { errorHandler } from './errorHandler';`,
  pkg: `{
  "name": "storefront",
  "scripts": { "test": "vitest run", "lint": "eslint ." },
  "dependencies": { "express": "^5.1.0", "ioredis": "^5.6.1", "zod": "^4.1.0" }
}`,
  rateLimit: `import type { RequestHandler } from 'express';

const hits = new Map<string, number[]>();

export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.apiKey) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      const ttlMs = windowMs - (now - recent[0]);
      res.set('Retry-After', String(ttlMs));
      return res.status(429).json({ error: 'rate_limited' });
    }
    hits.set(req.apiKey, [...recent, now]);
    next();
  };
}`,
  rateLimitRedis: `import type { RequestHandler } from 'express';
import { redis } from '../lib/redis';

export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }): RequestHandler {
  return async (req, res, next) => {
    const window = Math.floor(Date.now() / windowMs);
    const key = \`rl:checkout:\${req.apiKey}:\${window}\`;
    const [[, count], [, ttlMs]] = await redis.multi().incr(key).pexpire(key, windowMs).pttl(key).exec();
    if (Number(count) > limit) {
      res.set('Retry-After', String(ttlMs));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}`,
  redis: `import Redis from 'ioredis';
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');`,
  cartExpiry: `import { redis } from '../lib/redis';
export async function expireCarts(ids: string[]) {
  const tx = redis.multi();
  for (const id of ids) tx.expire(\`cart:\${id}\`, 3600);
  await tx.exec();
}`,
  checkoutTest: `import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('POST /checkout', () => {
  beforeEach(() => {
    resetDb();
  });
  it('creates an order', async () => {
    const res = await request(app).post('/checkout').set('x-api-key', 'test').send({ cart: fixtures.cart });
    expect(res.status).toBe(201);
  });
});`,
  retryAfterTest: `describe('POST /checkout', () => {
  it('answers 429 with Retry-After in seconds after 20 requests', async () => {
    for (let i = 0; i < 20; i++) await request(app).post('/checkout').set('x-api-key', 'burst').send({ cart: fixtures.cart });
    const res = await request(app).post('/checkout').set('x-api-key', 'burst').send({ cart: fixtures.cart });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
  });`,
};

const TEST = {
  fail: `${vitest(13, 'rejects an empty cart', 14)}

 FAIL  test/checkout.test.ts > POST /checkout > rejects an empty cart
AssertionError: expected 429 to be 400
 ❯ test/checkout.test.ts:41:24

 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
Exit code 1`,
  failRetry: `${vitest(14, 'answers 429 over the limit', 15)}

 FAIL  test/checkout.test.ts > POST /checkout > answers 429 with Retry-After in seconds after 20 requests
AssertionError: expected 59412 to be less than or equal to 60
 ❯ test/checkout.test.ts:12:52

 Test Files  1 failed (1)
      Tests  1 failed | 14 passed (15)
Exit code 1`,
  pass: (n) => `${vitest(n, null, 15)}
 ✓ test/checkout.test.ts (${Math.min(n, 15)} tests)
 Test Files  ${n > 20 ? 31 : 1} passed (${n > 20 ? 31 : 1})
      Tests  ${n} passed (${n})
   Duration  ${n > 20 ? '11.84' : '3.12'}s`,
};

export const scenario = {
  project: 'storefront',
  branch: 'feat/checkout-rate-limit',
  model: 'claude-opus-5-5',
  ccVersion: '2.1.326',
  sessionId: '4f3c2a1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
  /** Tokens of system prompt, tools and CLAUDE.md written to the cache on the first call. */
  baseContextTokens: 58_400,
  turns: [
    {
      prompt:
        'Add rate limiting to POST /checkout: 20 requests per minute per API key, and answer 429 with a Retry-After header.',
      memory: { path: 'CLAUDE.md', tokens: 1_900 },
      steps: [
        {
          say: "I'll start by looking at how the checkout route and the middleware stack are wired.",
          tool: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read checkout route and middleware', status: 'in_progress', activeForm: 'Reading checkout route' },
              { content: 'Add a per-key rate limiter', status: 'pending', activeForm: 'Adding the rate limiter' },
              { content: 'Return 429 with Retry-After', status: 'pending', activeForm: 'Returning 429' },
              { content: 'Run the checkout tests', status: 'pending', activeForm: 'Running tests' },
            ],
          },
          result: 'Todos have been modified successfully.',
          ms: 120,
        },
        { tool: 'Read', input: { file_path: 'src/routes/checkout.ts' }, result: read(CODE.checkout, 186), ms: 90 },
        { tool: 'Read', input: { file_path: 'src/middleware/index.ts' }, result: read(CODE.middleware, 64), ms: 70 },
        {
          tool: 'Grep',
          input: { pattern: 'rateLimit|express-rate-limit', path: 'src', output_mode: 'files_with_matches' },
          result: 'No files found',
          ms: 160,
        },
        { tool: 'Read', input: { file_path: 'package.json' }, result: read(CODE.pkg, 58), ms: 60 },
        {
          say: "There's no limiter yet. I'll add a small sliding-window limiter keyed by API key.",
          tool: 'Write',
          input: { file_path: 'src/middleware/rateLimit.ts', content: CODE.rateLimit },
          result: 'File created successfully at: src/middleware/rateLimit.ts',
          ms: 110,
          output: 1_150,
        },
        {
          tool: 'Edit',
          input: { file_path: 'src/routes/checkout.ts', old_string: "router.post('/checkout', validateCart,", new_string: "router.post('/checkout', rateLimit({ limit: 20, windowMs: 60_000 }), validateCart," },
          result: 'The file src/routes/checkout.ts has been updated successfully.',
          ms: 80,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test -- checkout', description: 'Run checkout tests' },
          result: TEST.fail,
          ms: 9_400,
          error: true,
          hook: { name: 'PreToolUse:Bash', command: 'bash .claude/hooks/guard-secrets.sh', ms: 240 },
        },
        { tool: 'Read', input: { file_path: 'test/checkout.test.ts' }, result: read(CODE.checkoutTest, 240), ms: 80 },
        {
          say: 'The test client shares one API key across cases, so the window must reset between tests.',
          tool: 'Edit',
          input: { file_path: 'src/middleware/rateLimit.ts', old_string: 'const hits = new Map', new_string: 'export const hits = new Map' },
          result: 'The file src/middleware/rateLimit.ts has been updated successfully.',
          ms: 70,
        },
        {
          tool: 'Edit',
          input: { file_path: 'test/checkout.test.ts', old_string: "beforeEach(() => {", new_string: "beforeEach(() => {\n    hits.clear();" },
          result: 'The file test/checkout.test.ts has been updated successfully.',
          ms: 70,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test -- checkout', description: 'Run checkout tests' },
          result: TEST.pass(14),
          ms: 8_700,
          hook: { name: 'PreToolUse:Bash', command: 'bash .claude/hooks/guard-secrets.sh', ms: 210 },
        },
        { tool: 'TodoWrite', input: { todos: [{ content: 'Read checkout route and middleware', status: 'completed', activeForm: 'Reading checkout route' }, { content: 'Add a per-key rate limiter', status: 'completed', activeForm: 'Adding the rate limiter' }, { content: 'Return 429 with Retry-After', status: 'completed', activeForm: 'Returning 429' }, { content: 'Run the checkout tests', status: 'completed', activeForm: 'Running tests' }] }, result: 'Todos have been modified successfully.', ms: 110 },
      ],
      reply:
        'Rate limiting is on for POST /checkout: 20 requests per minute per API key, with a 429 and Retry-After when a key goes over. All 14 checkout tests pass.',
    },
    {
      prompt: 'We run four instances behind the load balancer. Keep the counters in Redis so the limit holds across them.',
      steps: [
        {
          tool: 'Agent',
          input: { subagent_type: 'Explore', description: 'Find the Redis client', prompt: 'Find where the app creates its Redis client and how other modules use it. Report file paths and the exported API.' },
          ms: 21_000,
          agent: {
            id: 'a7e3c91f04d2b6a8',
            type: 'Explore',
            model: 'claude-haiku-5-5',
            steps: [
              { tool: 'Grep', input: { pattern: 'createClient|ioredis', path: 'src' }, result: 'src/lib/redis.ts\nsrc/jobs/cartExpiry.ts', ms: 140 },
              { tool: 'Read', input: { file_path: 'src/lib/redis.ts' }, result: read(CODE.redis, 40), ms: 60 },
              { tool: 'Read', input: { file_path: 'src/jobs/cartExpiry.ts' }, result: read(CODE.cartExpiry, 96), ms: 60 },
            ],
            report:
              'src/lib/redis.ts exports a shared ioredis client (`redis`) created from REDIS_URL. src/jobs/cartExpiry.ts uses it with MULTI/EXPIRE. No other module creates its own client.',
          },
          result:
            'src/lib/redis.ts exports a shared ioredis client (`redis`) created from REDIS_URL. src/jobs/cartExpiry.ts uses it with MULTI/EXPIRE. No other module creates its own client.\nagentId: a7e3c91f04d2b6a8 (use SendMessage with to: \'a7e3c91f04d2b6a8\' to continue this agent)',
          tokens: 320,
        },
        {
          tool: 'WebFetch',
          input: { url: 'https://redis.io/docs/latest/commands/incr/', prompt: 'The rate limiter pattern with INCR and EXPIRE' },
          result: 'INCR is atomic. For a fixed-window limiter, INCR the key for the current window and set EXPIRE on the first increment; reject when the value exceeds the limit.',
          tokens: 1_400,
          ms: 2_600,
        },
        {
          say: 'A fixed window with INCR and EXPIRE in one MULTI keeps it to a single round trip.',
          tool: 'Write',
          input: { file_path: 'src/middleware/rateLimit.ts', content: CODE.rateLimitRedis },
          result: 'The file src/middleware/rateLimit.ts has been updated successfully.',
          ms: 120,
          output: 1_300,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test -- checkout', description: 'Run checkout tests' },
          result: TEST.pass(14),
          ms: 10_200,
          hook: { name: 'PreToolUse:Bash', command: 'bash .claude/hooks/guard-secrets.sh', ms: 230 },
        },
        {
          tool: 'Bash',
          input: { command: 'rm -rf node_modules/.cache dist', description: 'Clear build caches' },
          result: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
          denied: true,
          ms: 4_000,
        },
      ],
      reply:
        'The limiter now keeps its counters in Redis through the shared client, so all four instances enforce one limit per key. Tests still pass. I skipped clearing the build caches since you declined it.',
    },
    {
      live: true,
      prompt: 'Add a test for the Retry-After header, then open a PR.',
      steps: [
        { tool: 'TodoWrite', input: { todos: [{ content: 'Add a Retry-After test', status: 'in_progress', activeForm: 'Adding a Retry-After test' }, { content: 'Fix what the test finds', status: 'pending', activeForm: 'Fixing what the test finds' }, { content: 'Update the changelog', status: 'pending', activeForm: 'Updating the changelog' }, { content: 'Open a PR', status: 'pending', activeForm: 'Opening a PR' }] }, result: 'Todos have been modified successfully.', ms: 110 },
        { tool: 'Read', input: { file_path: 'test/checkout.test.ts' }, result: read(CODE.checkoutTest, 252, 9), ms: 70 },
        {
          say: "I'll add a case that sends 21 requests and checks the last one.",
          tool: 'Edit',
          input: { file_path: 'test/checkout.test.ts', old_string: "describe('POST /checkout', () => {", new_string: CODE.retryAfterTest },
          result: 'The file test/checkout.test.ts has been updated successfully.',
          ms: 80,
          output: 900,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test -- checkout', description: 'Run checkout tests' },
          result: TEST.failRetry,
          ms: 9_800,
          error: true,
          hook: { name: 'PreToolUse:Bash', command: 'bash .claude/hooks/guard-secrets.sh', ms: 220 },
        },
        {
          say: 'Retry-After should be whole seconds. The middleware sends milliseconds.',
          tool: 'Edit',
          input: { file_path: 'src/middleware/rateLimit.ts', old_string: "res.set('Retry-After', String(ttlMs))", new_string: "res.set('Retry-After', String(Math.ceil(ttlMs / 1000)))" },
          result: 'The file src/middleware/rateLimit.ts has been updated successfully.',
          ms: 70,
        },
        {
          tool: 'Bash',
          input: { command: 'npm test', description: 'Run the full test suite' },
          result: TEST.pass(212),
          ms: 14_500,
          hook: { name: 'PreToolUse:Bash', command: 'bash .claude/hooks/guard-secrets.sh', ms: 240 },
        },
        { tool: 'TodoWrite', input: { todos: [{ content: 'Add a Retry-After test', status: 'completed', activeForm: 'Adding a Retry-After test' }, { content: 'Fix what the test finds', status: 'completed', activeForm: 'Fixing what the test finds' }, { content: 'Update the changelog', status: 'in_progress', activeForm: 'Updating the changelog' }, { content: 'Open a PR', status: 'pending', activeForm: 'Opening a PR' }] }, result: 'Todos have been modified successfully.', ms: 110 },
        {
          tool: 'Skill',
          input: { skill: 'changelog', args: 'checkout rate limiting' },
          result: 'Launching skill: changelog',
          tokens: 800,
          ms: 400,
        },
        {
          tool: 'Edit',
          input: { file_path: 'CHANGELOG.md', old_string: '## Unreleased', new_string: '## Unreleased\n\n- POST /checkout is rate limited to 20 requests per minute per API key (429 with Retry-After).' },
          result: 'The file CHANGELOG.md has been updated successfully.',
          ms: 60,
        },
        {
          tool: 'Bash',
          input: { command: 'git checkout -b feat/checkout-rate-limit && git add -A && git commit -m "feat(checkout): rate limit per API key"', description: 'Commit on a new branch' },
          result: '[feat/checkout-rate-limit 3e9a1c4] feat(checkout): rate limit per API key\n 5 files changed, 118 insertions(+), 6 deletions(-)',
          tokens: 200,
          ms: 1_300,
          hook: { name: 'PreToolUse:Bash', command: 'bash .claude/hooks/guard-secrets.sh', ms: 200 },
        },
        {
          tool: 'mcp__github__create_pull_request',
          input: { owner: 'acme', repo: 'storefront', title: 'Rate limit POST /checkout per API key', head: 'feat/checkout-rate-limit', base: 'main' },
          result: '{"number":482,"url":"https://github.com/acme/storefront/pull/482","state":"open"}',
          tokens: 300,
          ms: 2_100,
        },
        { tool: 'TodoWrite', input: { todos: [{ content: 'Add a Retry-After test', status: 'completed', activeForm: 'Adding a Retry-After test' }, { content: 'Fix what the test finds', status: 'completed', activeForm: 'Fixing what the test finds' }, { content: 'Update the changelog', status: 'completed', activeForm: 'Updating the changelog' }, { content: 'Open a PR', status: 'completed', activeForm: 'Opening a PR' }] }, result: 'Todos have been modified successfully.', ms: 110 },
      ],
      reply:
        'Added a Retry-After test, which caught the header being sent in milliseconds; it now reports whole seconds. The full suite passes (212 tests) and PR #482 is open: https://github.com/acme/storefront/pull/482',
    },
  ],
};

/** Prompts for the backdated history: other days, smaller sessions. */
export const historyPrompts = [
  'Fix the flaky cart total test on CI',
  'Add pagination to GET /orders',
  'Upgrade express to v5 and fix the breaking changes',
  'Write a migration for the invoice status column',
  'Why does the webhook retry loop never stop?',
  'Add an index for orders by customer and date',
  'Refactor the price calculator into pure functions',
  'Add OpenAPI docs for the refunds endpoints',
  'Sentry shows a null shipping address crash, fix it',
  'Speed up the product search query',
  'Add a dry-run flag to the cart expiry job',
  'Review the discount code validation for edge cases',
  'Move config loading to zod with defaults',
  'Add request ids to the logger',
];
