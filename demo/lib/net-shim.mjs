/**
 * Network shim for processes in the demo sandbox, loaded with `node --import`.
 *
 * Recordings must not depend on the outside world: the dashboards poll the
 * public status pages, and a real incident would land in the footage. Status
 * pages answer "operational", the Claude usage endpoint answers with the demo
 * login's quota (SK_DEMO_QUOTA), and every other request fails, which keeps
 * pricing and update checks on their offline paths.
 */
import http from 'node:http';
import https from 'node:https';

const operational = () =>
  JSON.stringify({
    page: { updated_at: new Date().toISOString() },
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [],
    incidents: [],
  });
const STATUS_HOSTS = new Set(['status.claude.com', 'status.anthropic.com', 'status.openai.com']);

/** The demo login's usage, set by the sandbox (SK_DEMO_QUOTA). */
function usageBody() {
  try {
    return process.env.SK_DEMO_QUOTA || '{}';
  } catch {
    return '{}';
  }
}

const refuse = (target) => new TypeError(`fetch failed: network is disabled in the demo sandbox (${target})`);

globalThis.fetch = async function demoFetch(input) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    /* not a URL */
  }
  if (STATUS_HOSTS.has(host)) {
    return new Response(operational(), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (host === 'api.anthropic.com' && raw.includes('/api/oauth/usage')) {
    return new Response(usageBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw refuse(host || String(raw));
};

for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    mod[name] = function demoRequest(target) {
      const host = typeof target === 'string' ? target : target?.hostname ?? target?.host ?? 'unknown host';
      throw refuse(String(host));
    };
  }
}
